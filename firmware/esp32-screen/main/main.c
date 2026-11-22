// Kiosko remote screen: boot, the screen's own pages (idle, pairing, setup),
// the BOOT button and the OTA rollback guard.
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "app.h"
#include "board.h"

static const char *TAG = "main";

static TaskHandle_t ui_task;
static volatile bool showing_frames, frames_overdrawn;
static volatile int hold_ms;              // BOOT being held, for the hint on the screen
static volatile const char *flash_msg;    // a one-off message (after a long press)
static int64_t flash_until_us;

void app_heap_note(const char *when)
{
    ESP_LOGI("heap", "%s: free %u, lowest %u, largest block %u", when, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
}

void ui_kick(void) { if (ui_task) xTaskNotifyGive(ui_task); }
bool app_showing_frames(void) { return showing_frames; }
void app_frames_started(void) { showing_frames = true; frames_overdrawn = false; }

// ---- rollback guard -----------------------------------------------------------------
// A firmware fresh from an OTA must be on the Wi-Fi with its server listening for 30 s;
// otherwise (a crash, a hang, no network in time) it restarts and the bootloader goes
// back to the one before. When it came by Kiosko's own OTA, or it just replaced another
// firmware (no settings of its own yet), it must also have had an authenticated Kiosko
// session, within 10 min: an update that Kiosko can't talk to again does not stay.
static bool pending, confirming, need_session, had_session;
static esp_timer_handle_t confirm_timer, deadline_timer;
volatile bool app_server_up;

static void confirm_cb(void *arg)
{
    if (net_state() != NET_ONLINE || (need_session && !had_session)) { confirming = false; return; }
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) ESP_LOGI(TAG, "this firmware is confirmed");
    app_heap_note("confirmed");
    pending = false;
    esp_timer_stop(deadline_timer);
}

static void deadline_cb(void *arg)
{
    if (!pending) return;
    ESP_LOGE(TAG, "not proven in time after an update: restarting, back to the previous firmware");
    esp_restart();
}

void app_healthy_check(void)
{
    if (!pending || confirming || !app_server_up || net_state() != NET_ONLINE || (need_session && !had_session)) return;
    confirming = true;
    esp_timer_start_once(confirm_timer, 30 * 1000000ULL);
}

void app_session_ok(void)
{
    had_session = true;
    app_healthy_check();
}

static void crash_cb(void *arg)
{
    ESP_LOGE(TAG, "KS_TEST_CRASH_AFTER: crashing on purpose");
    abort();
}

// ---- the screen's own pages ------------------------------------------------------------

static const uint16_t BG = RGB565(14, 20, 32), FG = RGB565(240, 244, 250), MUT = RGB565(150, 165, 190), ACC = RGB565(90, 160, 255);

typedef struct { const char *title; const char **lines; int n; uint16_t color; } page_t;

// Run once per band (display_paint): the layout is the same each time, the band clips it.
static void page_paint(void *ctx)
{
    const page_t *pg = ctx;
    const char *title = pg->title, **lines = pg->lines;
    int n = pg->n;
    uint16_t title_color = pg->color;
    fb_clear(BG);
    int total = fb_text_height(TXT_SMALL) + 10;
    for (int i = 0; i < n; i++) total += fb_text_height(lines[i][0] == '\x01' ? TXT_HUGE : lines[i][0] == '\x02' ? TXT_BIG : TXT_TINY) + 4;
    int y = (display_height() - total) / 2;
    y = fb_text_center(y, TXT_SMALL, title_color, title) + 10;
    for (int i = 0; i < n; i++) {
        const char *s = lines[i];
        txt_size_t sz = TXT_TINY;
        uint16_t c = MUT;
        if (s[0] == '\x01') { sz = TXT_HUGE; c = FG; s++; }
        else if (s[0] == '\x02') { sz = TXT_BIG; c = FG; s++; }
        y = fb_text_center(y, sz, c, s) + 4;
    }
}

static void page(const char *title, const char *lines[], int n, uint16_t title_color)
{
    page_t pg = { title, lines, n, title_color };
    display_paint(page_paint, &pg);
}

static void draw(const session_info_t *si, int64_t now)
{
    char host[48], b1[64], b2[64], clock[16] = "";
    snprintf(host, sizeof(host), "kiosko-%s.local", app_settings.id);
    if (net_time_ok()) {
        time_t t = time(NULL);
        struct tm tm;
        localtime_r(&t, &tm);
        strftime(clock + 1, sizeof(clock) - 1, "%H:%M", &tm);
        clock[0] = '\x02';
    }
    if (hold_ms >= 1500) {
        const char *l[] = { T("hold5"), T("hold10"), b1 };
        snprintf(b1, sizeof(b1), "\x02%d s", hold_ms / 1000);
        page(T("hold"), l, 3, ACC);
        return;
    }
    if (flash_msg && now < flash_until_us) {
        const char *l[] = { app_settings.id };
        page((const char *)flash_msg, l, 1, ACC);
        return;
    }
    if (si->pairing) {
        int left = (int)((si->pair_until_us - now) / 1000000);
        snprintf(b1, sizeof(b1), "\x01%.3s %.3s", si->code, si->code + 3);
        snprintf(b2, sizeof(b2), "%s · %d s", si->pair_peer, left < 0 ? 0 : left);
        const char *l[] = { b1, T("pairing2"), b2 };
        page(T("pairing"), l, 3, ACC);
        return;
    }
    if (si->ota) {
        const char *l[] = { app_settings.id };
        page(T("updating"), l, 1, ACC);
        return;
    }
    net_state_t st = net_state();
    if (st == NET_SETUP) {
        snprintf(b1, sizeof(b1), "\x02%s", net_ap_pass());
        const char *l[] = { T("join"), net_ap_ssid(), T("password"), b1, T("open"), "http://192.168.4.1" };
        page(T("setup"), l, 6, ACC);
        return;
    }
    if (st == NET_CONNECTING) {
        const char *l[] = { app_settings.id, clock[0] ? clock : "" };
        page(T("connecting"), l, clock[0] ? 2 : 1, FG);
        return;
    }
    const char *status = si->online ? T("connected") : app_settings.paired ? T("waiting") : T("unpaired1");
    if (now < si->window_until_us) {
        const char *l[] = { T("window2"), app_settings.id, host, net_ip() };
        page(T("window"), l, 4, ACC);
        return;
    }
    const char *l[6];
    int n = 0;
    if (clock[0]) l[n++] = clock;
    l[n++] = app_settings.id;
    l[n++] = host;
    l[n++] = net_ip();
    if (!app_settings.paired && !si->online) l[n++] = T("unpaired2");
    page(status, l, n, si->online || app_settings.paired ? FG : ACC);
}

static void ui_loop(void)
{
    char last_sig[96] = "";
    int64_t last_draw = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(250));
        session_info_t si;
        session_get(&si);
        int64_t now = esp_timer_get_time();
        // Kiosko's frames stay while it is connected, and a while after it goes.
        if (showing_frames && !si.online && si.last_frame_us && now - si.last_frame_us > app_settings.idle * 1000000LL) showing_frames = false;
        bool overlay = si.pairing || hold_ms >= 1500 || (flash_msg && now < flash_until_us) || si.ota || now < si.window_until_us;
        if (showing_frames && !overlay) {
            if (frames_overdrawn) { frames_overdrawn = false; session_request_resend(); }
            last_sig[0] = 0;
            continue;
        }
        if (showing_frames) frames_overdrawn = true;
        time_t t = time(NULL);
        char sig[96];
        snprintf(sig, sizeof(sig), "%d|%d|%d|%d|%d|%d|%s|%s|%ld|%d|%d", net_state(), si.online, si.pairing, si.ota, app_settings.paired,
                 now < si.window_until_us, net_ip(), app_settings.id, si.pairing ? (long)((si.pair_until_us - now) / 1000000) : (long)(t / 60),
                 hold_ms / 1000, display_rotation());
        if (!strcmp(sig, last_sig) && now - last_draw < 60 * 1000000LL) continue;
        strcpy(last_sig, sig);
        last_draw = now;
        draw(&si, now);
    }
}

// ---- BOOT ---------------------------------------------------------------------------------
// Short press: open pairing on a paired screen for 2 min (or cancel a pairing in progress).
// Hold 5 s: forget the pairing. Hold 10 s: forget the pairing and the Wi-Fi, restart in setup.
// Polled every 50 ms while up (the chip light-sleeps in between), every 30 ms while held.
static void button_task(void *arg)
{
    gpio_config_t io = { .pin_bit_mask = 1ULL << BOARD_BUTTON, .mode = GPIO_MODE_INPUT, .pull_up_en = 1 };
    gpio_config(&io);
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(50));
        if (gpio_get_level(BOARD_BUTTON)) continue;
        int ms = 0;
        while (!gpio_get_level(BOARD_BUTTON) && ms < 12000) {
            vTaskDelay(pdMS_TO_TICKS(30));
            ms += 30;
            if (ms >= 1500 && ms / 1000 != hold_ms / 1000) { hold_ms = ms; ui_kick(); }
        }
        hold_ms = 0;
        if (ms >= 10000) {
            settings_forget_pairing();
            settings_forget_wifi();
            flash_msg = T("forgotall");
            flash_until_us = esp_timer_get_time() + 3000000;
            ui_kick();
            vTaskDelay(pdMS_TO_TICKS(2000));
            esp_restart();
        } else if (ms >= 5000) {
            settings_forget_pairing();
            session_kick();
            net_announce();
            flash_msg = T("forgot");
            flash_until_us = esp_timer_get_time() + 3000000;
        } else if (ms >= 30) {
            session_info_t si;
            session_get(&si);
            if (si.pairing || esp_timer_get_time() < si.window_until_us) session_cancel_pairing();
            else if (app_settings.paired) session_open_window();
        }
        ui_kick();
        while (!gpio_get_level(BOARD_BUTTON)) vTaskDelay(pdMS_TO_TICKS(30));
    }
}

void app_main(void)
{
    logbuf_init();
    app_heap_note("boot");
    settings_load();
    display_init();
    app_heap_note("display up");
    display_set_rotation(app_settings.rot);
    led_init();
    power_init();
    ui_task = xTaskGetCurrentTaskHandle();

    esp_ota_img_states_t st;
    const esp_partition_t *run = esp_ota_get_running_partition();
    pending = esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
    esp_timer_create_args_t ca = { .callback = confirm_cb, .name = "confirm" }, da = { .callback = deadline_cb, .name = "deadline" };
    ESP_ERROR_CHECK(esp_timer_create(&ca, &confirm_timer));
    ESP_ERROR_CHECK(esp_timer_create(&da, &deadline_timer));
    if (pending) {
        need_session = app_ota_by_kiosko || app_first_boot;
        ESP_LOGW(TAG, "new firmware on trial: online and serving for 30 s%s", need_session ? ", after a Kiosko session" : "");
        esp_timer_start_once(deadline_timer, (need_session ? 600 : 120) * 1000000ULL);
    }
#if CONFIG_KS_TEST_CRASH_AFTER > 0
    esp_timer_handle_t ct;
    esp_timer_create_args_t cra = { .callback = crash_cb, .name = "crash" };
    esp_timer_create(&cra, &ct);
    esp_timer_start_once(ct, CONFIG_KS_TEST_CRASH_AFTER * 1000000ULL);
#else
    (void)crash_cb;
#endif

    if (CONFIG_KS_TEST_PAIR_CODE[0]) ESP_LOGW(TAG, "TEST BUILD: the pairing code is fixed; do not use this build");
    net_start();
    session_start();
    web_start();
    xTaskCreate(button_task, "button", 3072, NULL, 5, NULL);
    app_heap_note("all started");
    ESP_LOGI(TAG, "Kiosko screen %s on %s, %s, free RAM %u B (largest block %u B)", esp_app_get_description()->version, BOARD_MODEL, run->label,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    ui_loop();
}
