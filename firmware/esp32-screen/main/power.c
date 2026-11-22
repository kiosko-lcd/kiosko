// Keeping the board cool: power management, the Wi-Fi's power save and the chip's
// temperature.
//
// - Power management (esp_pm): the CPU scales between 80 and 160 MHz and the chip
//   light-sleeps whenever every task is idle, waking for the Wi-Fi's beacons, its
//   timers and the BOOT poll. A frame (receive, decrypt, JPEG decode) holds the CPU at
//   its top speed (power_busy_*), which also keeps it awake; the SPI driver holds
//   its own lock while the DMA sends the picture to the panel.
// - Wi-Fi: modem sleep (WIFI_PS_MIN_MODEM) by default, so the radio sleeps between
//   beacons. While frames come fast (an interlude, an animation: more than 2 fps over
//   3 s) it switches power save off, since modem sleep holds each received frame back
//   until the next beacon, and goes back to modem sleep after 5 quiet seconds (under
//   1 fps). An OTA keeps it off too.
// - The chip's own temperature sensor, read every 5 s.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "driver/temperature_sensor.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_timer.h"
#include "app.h"

static const char *TAG = "power";

#define FAST_IN_WINDOW_US   (3 * 1000000LL)  // 2 fps over 3 s: 6 frames
#define FAST_IN_FRAMES      6
#define FAST_OUT_WINDOW_US  (5 * 1000000LL)  // under 1 fps over 5 s: back to modem sleep
#define FAST_OUT_FRAMES     5
#define RING                8

static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static int64_t seen[RING];   // the latest frames' arrival times, a ring
static unsigned head;
static volatile bool fast;   // Wi-Fi power save off for the frames
static volatile int holds;   // power_hold_fast(): an OTA
static volatile float temp_c = NAN;
static temperature_sensor_handle_t tsens;
static SemaphoreHandle_t apply_lock;
#if CONFIG_PM_ENABLE
static esp_pm_lock_handle_t busy_lock;
#endif

void power_busy_begin(void)
{
#if CONFIG_PM_ENABLE
    if (busy_lock) esp_pm_lock_acquire(busy_lock);
#endif
}

void power_busy_end(void)
{
#if CONFIG_PM_ENABLE
    if (busy_lock) esp_pm_lock_release(busy_lock);
#endif
}

// Frames within the last `window` microseconds.
static int frames_within(int64_t now, int64_t window)
{
    int n = 0;
    for (int i = 0; i < RING; i++) if (seen[i] && now - seen[i] <= window) n++;
    return n;
}

// Decides, and tells the Wi-Fi, under one lock: two callers can't leave it the wrong way.
static void apply(void)
{
    if (!apply_lock) return;
    xSemaphoreTake(apply_lock, portMAX_DELAY);
    int64_t now = esp_timer_get_time();
    taskENTER_CRITICAL(&mux);
    int in = frames_within(now, FAST_IN_WINDOW_US), out = frames_within(now, FAST_OUT_WINDOW_US);
    bool want = holds > 0 || (fast ? out >= FAST_OUT_FRAMES : in >= FAST_IN_FRAMES);
    taskEXIT_CRITICAL(&mux);
    if (want != fast) {
        fast = want;
        ESP_LOGI(TAG, "Wi-Fi power save %s", want ? "off (frames coming fast)" : "on (modem sleep)");
        net_set_low_latency(want);
    }
    xSemaphoreGive(apply_lock);
}

void power_frame_seen(void)
{
    taskENTER_CRITICAL(&mux);
    seen[head++ % RING] = esp_timer_get_time();
    taskEXIT_CRITICAL(&mux);
    apply();
}

void power_hold_fast(bool on)
{
    taskENTER_CRITICAL(&mux);
    holds += on ? 1 : -1;
    if (holds < 0) holds = 0;
    taskEXIT_CRITICAL(&mux);
    apply();
}

bool power_fast(void) { return fast; }

float power_temp_c(void) { return temp_c; }

// esp_pm's profile (CONFIG_PM_PROFILING): the time in each mode since boot, as text.
size_t power_profile(char *out, size_t max)
{
#if CONFIG_PM_PROFILING
    FILE *f = fmemopen(out, max, "w");
    if (!f) return 0;
    esp_pm_dump_locks(f);
    long n = ftell(f);
    fclose(f);
    if (n < 0) n = 0;
    if ((size_t)n >= max) n = max - 1;
    out[n] = 0;
    return n;
#else
    if (max) out[0] = 0;
    return 0;
#endif
}

// The share of the time since boot spent in light sleep, from the profile; -1 if unknown.
int power_sleep_pct(void)
{
#if CONFIG_PM_PROFILING
    char *b = malloc(1536);
    if (!b) return -1;
    power_profile(b, 1536);
    int pct = -1;
    // "SLEEP     40 M       123456      87%"
    for (char *l = b; l && *l; l = strchr(l, '\n'), l = l ? l + 1 : NULL) {
        if (strncmp(l, "SLEEP ", 6)) continue;
        char *p = strchr(l, '%');
        if (!p) break;
        while (p > l && p[-1] >= '0' && p[-1] <= '9') p--;
        pct = atoi(p);
        break;
    }
    free(b);
    return pct;
#else
    return -1;
#endif
}

static void tick_cb(void *arg)
{
    apply(); // the way back to modem sleep when frames stop
    static int n;
    if (tsens && n++ % 5 == 0) {
        float t;
        if (temperature_sensor_get_celsius(tsens, &t) == ESP_OK) temp_c = t;
    }
}

void power_init(void)
{
    apply_lock = xSemaphoreCreateMutex();
#if CONFIG_PM_ENABLE
    esp_pm_config_t pm = { .max_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ, .min_freq_mhz = 80, .light_sleep_enable = CONFIG_FREERTOS_USE_TICKLESS_IDLE };
    esp_err_t r = esp_pm_configure(&pm);
    if (r == ESP_OK) r = esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "frame", &busy_lock);
    if (r != ESP_OK) ESP_LOGW(TAG, "power management off: %s", esp_err_to_name(r));
    else ESP_LOGI(TAG, "CPU %d-%d MHz, light sleep %s", pm.min_freq_mhz, pm.max_freq_mhz, pm.light_sleep_enable ? "on" : "off");
#endif
    temperature_sensor_config_t tc = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&tc, &tsens) != ESP_OK || temperature_sensor_enable(tsens) != ESP_OK) {
        ESP_LOGW(TAG, "no temperature sensor");
        tsens = NULL;
    }
    esp_timer_handle_t t;
    esp_timer_create_args_t a = { .callback = tick_cb, .name = "power" };
    ESP_ERROR_CHECK(esp_timer_create(&a, &t));
    ESP_ERROR_CHECK(esp_timer_start_periodic(t, 1000000));
    tick_cb(NULL);
}
