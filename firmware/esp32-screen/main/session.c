// The protocol server (TCP 7428, docs/remote-screen.md): pairing by SPAKE2 on a
// code shown on the glass, then one authenticated, sealed session at a time
// with a Kiosko that sends frames (latest wins: it waits for each ACK).
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "app.h"
#include "board.h"
#include "ks_proto.h"

static const char *TAG = "session";

#define SMALL_MAX       1024
#define MAX_CONNS       2
#define PAIR_TTL_S      120
#define WINDOW_S        120
#define SESSION_IDLE_S  20
#define STATE_EVERY_S   30   // the state again (its temperature), unasked

static session_info_t info;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static SemaphoreHandle_t session_lock;   // held by the one session that uses `big`
static uint8_t *big;
static volatile int session_fd = -1, pair_fd = -1;
static volatile int conns;
static int failures;
static int64_t lock_until_us;

void ks_random(void *out, size_t len) { esp_fill_random(out, len); }

void session_get(session_info_t *out)
{
    taskENTER_CRITICAL(&mux);
    *out = info;
    taskEXIT_CRITICAL(&mux);
}

void session_open_window(void)
{
    taskENTER_CRITICAL(&mux);
    info.window_until_us = esp_timer_get_time() + WINDOW_S * 1000000LL;
    taskEXIT_CRITICAL(&mux);
    ESP_LOGI(TAG, "pairing open for %d s", WINDOW_S);
    ui_kick();
}

void session_cancel_pairing(void)
{
    int fd = pair_fd;
    if (fd >= 0) shutdown(fd, SHUT_RDWR);
    taskENTER_CRITICAL(&mux);
    info.window_until_us = 0;
    taskEXIT_CRITICAL(&mux);
    ui_kick();
}

static volatile bool want_resend;
void session_request_resend(void) { want_resend = true; }

void session_kick(void)
{
    int fd = session_fd;
    if (fd >= 0) shutdown(fd, SHUT_RDWR);
}

// ---- wire ------------------------------------------------------------------------

static void set_timeout(int fd, int ms)
{
    struct timeval tv = { .tv_sec = ms / 1000, .tv_usec = (ms % 1000) * 1000 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
}

static int read_full(int fd, uint8_t *b, size_t n)
{
    while (n) {
        int r = recv(fd, b, n, 0);
        if (r <= 0) return -1;
        b += r; n -= r;
    }
    return 0;
}

static int write_full(int fd, const uint8_t *b, size_t n)
{
    while (n) {
        int r = send(fd, b, n, 0);
        if (r <= 0) return -1;
        b += r; n -= r;
    }
    return 0;
}

// Plain message: u32 BE length, type, JSON.
static int send_plain(int fd, uint8_t type, cJSON *j)
{
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    if (!s) return -1;
    size_t n = strlen(s);
    uint8_t hdr[5] = { (n + 1) >> 24, (n + 1) >> 16, (n + 1) >> 8, n + 1, type };
    int r = write_full(fd, hdr, 5) || write_full(fd, (uint8_t *)s, n) ? -1 : 0;
    cJSON_free(s);
    return r;
}

static cJSON *recv_plain(int fd, uint8_t want)
{
    uint8_t hdr[4], buf[SMALL_MAX + 1];
    if (read_full(fd, hdr, 4)) return NULL;
    uint32_t L = (uint32_t)hdr[0] << 24 | hdr[1] << 16 | hdr[2] << 8 | hdr[3];
    if (L < 1 || L > SMALL_MAX) return NULL;
    if (read_full(fd, buf, L)) return NULL;
    if (buf[0] != want) return NULL;
    buf[L] = 0;
    cJSON *j = cJSON_ParseWithLength((char *)buf + 1, L - 1);
    return cJSON_IsObject(j) ? j : (cJSON_Delete(j), NULL);
}

static void send_error(int fd, const char *code, const char *msg)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "code", code);
    cJSON_AddStringToObject(j, "msg", msg);
    send_plain(fd, KS_ERROR, j);
    ESP_LOGW(TAG, "refused: %s", code);
}

static const char *jstr(const cJSON *j, const char *k)
{
    const cJSON *v = cJSON_GetObjectItem(j, k);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

static bool pairing_allowed(void)
{
    return !app_settings.paired || esp_timer_get_time() < info.window_until_us;
}

static cJSON *describe(bool full)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddNumberToObject(j, "proto", KS_PROTO);
    cJSON_AddStringToObject(j, "uid", app_uid);
    cJSON_AddStringToObject(j, "id", app_settings.id);
    cJSON_AddStringToObject(j, "model", BOARD_MODEL);
    cJSON_AddNumberToObject(j, "w", BOARD_LCD_W);
    cJSON_AddNumberToObject(j, "h", BOARD_LCD_H);
    cJSON_AddNumberToObject(j, "rot", display_rotation());
    cJSON_AddStringToObject(j, "fw", esp_app_get_description()->version);
    cJSON_AddNumberToObject(j, "max", CONFIG_KS_RX_MAX - 64);
    if (full) {
        cJSON_AddNumberToObject(j, "last", info.last_frame);
        cJSON_AddNumberToObject(j, "up", (double)(esp_timer_get_time() / 1000000));
        cJSON_AddNumberToObject(j, "heap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        cJSON_AddNumberToObject(j, "rssi", net_rssi());
        cJSON_AddStringToObject(j, "ip", net_ip());
        cJSON_AddStringToObject(j, "part", esp_ota_get_running_partition()->label);
        // Optional fields (firmware 0.1.2): an older Kiosko ignores them.
        cJSON_AddNumberToObject(j, "bright", app_settings.bright);
        // 0.1.4: the temporary dimming (-1: none); its presence tells Kiosko this firmware has it.
        cJSON_AddNumberToObject(j, "dim", info.dim);
        cJSON_AddNumberToObject(j, "heapMin", heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
        cJSON_AddNumberToObject(j, "heapLargest", heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        float t = power_temp_c();
        if (!isnan(t)) cJSON_AddNumberToObject(j, "tempC", roundf(t * 10) / 10);
    }
    return j;
}

// ---- pairing -------------------------------------------------------------------------

static void pair_flow(int fd)
{
    cJSON *j = recv_plain(fd, KS_PAIR_START);
    if (!j) return;
    char peer[sizeof(info.pair_peer)] = "Kiosko";
    const char *name = jstr(j, "name");
    if (name) strlcpy(peer, name, sizeof(peer));
    cJSON_Delete(j);
    int64_t now = esp_timer_get_time();
    if (!pairing_allowed()) { send_error(fd, "pairingClosed", "already paired: press BOOT on the screen to pair again"); return; }
    if (now < lock_until_us) { send_error(fd, "tooManyTries", "wrong codes: wait a moment"); return; }
    if (info.pairing || web_ota_running() || info.ota) { send_error(fd, "busy", "busy"); return; }

    uint32_t r;
    do r = esp_random(); while (r >= 4294000000UL); // uniform over 0..999999
    char code[7];
    snprintf(code, sizeof(code), "%06lu", (unsigned long)(r % 1000000UL));
    if (CONFIG_KS_TEST_PAIR_CODE[0]) strlcpy(code, CONFIG_KS_TEST_PAIR_CODE, sizeof(code));
    taskENTER_CRITICAL(&mux);
    info.pairing = true;
    strcpy(info.code, code);
    strcpy(info.pair_peer, peer);
    info.pair_until_us = now + PAIR_TTL_S * 1000000LL;
    taskEXIT_CRITICAL(&mux);
    pair_fd = fd;
    led_set(LED_SELF, 0x0050ff, 500);
    ui_kick();
    ESP_LOGI(TAG, "pairing: code on the screen for '%s'", peer);

    bool tried = false, ok = false;
    uint8_t w[32], X[KS_POINT_LEN], Y[KS_POINT_LEN], cA[32], cB[32], key[KS_KEY_LEN], c[32];
    j = cJSON_CreateObject();
    cJSON_AddNumberToObject(j, "ttl", PAIR_TTL_S);
    if (send_plain(fd, KS_PAIR_READY, j)) goto done;
    set_timeout(fd, PAIR_TTL_S * 1000);
    j = recv_plain(fd, KS_PAIR_X);
    if (!j) goto done;
    int bad = ks_hex_decode(jstr(j, "X"), X, sizeof(X));
    cJSON_Delete(j);
    if (bad || esp_timer_get_time() > info.pair_until_us) goto done;
    tried = true;
    ks_spake_w(app_uid, code, w);
    if (ks_spake_respond(w, NULL, X, app_uid, Y, cB, cA, key)) goto done;
    char hy[2 * KS_POINT_LEN + 1], hc[65];
    ks_hex_encode(Y, sizeof(Y), hy);
    ks_hex_encode(cB, sizeof(cB), hc);
    j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "Y", hy);
    cJSON_AddStringToObject(j, "c", hc);
    if (send_plain(fd, KS_PAIR_Y, j)) goto done;
    set_timeout(fd, 30000);
    j = recv_plain(fd, KS_PAIR_CONFIRM);
    if (!j) goto done;
    bad = ks_hex_decode(jstr(j, "c"), c, sizeof(c));
    cJSON_Delete(j);
    ok = !bad && ks_equal(c, cA, 32);
done:
    if (ok) {
        memcpy(app_settings.key, key, sizeof(key));
        app_settings.paired = true;
        strlcpy(app_settings.peer, peer, sizeof(app_settings.peer));
        settings_save();
        failures = 0;
        info.window_until_us = 0;
        session_kick(); // a session with the old key, if any, ends
        send_plain(fd, KS_PAIR_OK, cJSON_CreateObject());
        net_announce();
        ESP_LOGI(TAG, "paired with '%s'", peer);
        app_heap_note("paired");
    } else if (tried) {
        // Each wrong attempt waits longer: 5 s, 10 s, 20 s... up to 5 min.
        failures++;
        int wait = 5 << (failures - 1 > 6 ? 6 : failures - 1);
        lock_until_us = esp_timer_get_time() + (int64_t)(wait > 300 ? 300 : wait) * 1000000LL;
        send_error(fd, "badCode", "the code does not match");
    }
    mbedtls_platform_zeroize(key, sizeof(key));
    mbedtls_platform_zeroize(w, sizeof(w));
    mbedtls_platform_zeroize(code, sizeof(code));
    pair_fd = -1;
    taskENTER_CRITICAL(&mux);
    info.pairing = false;
    memset(info.code, 0, sizeof(info.code));
    taskEXIT_CRITICAL(&mux);
    led_release(LED_SELF);
    ui_kick();
}

// ---- the session -----------------------------------------------------------------------

typedef struct {
    int fd;
    ks_session_t s;
    esp_ota_handle_t ota;
    const esp_partition_t *ota_part;
    mbedtls_sha256_context ota_sha;
    uint32_t ota_size, ota_off;
    uint8_t ota_want[32];
    bool ota_on;
} sess_t;

// Seals in place: `b` holds the type and the payload (`len` bytes), with room for the tag after.
static int send_sealed_buf(sess_t *ss, uint8_t *b, size_t len)
{
    uint8_t hdr[4];
    return ks_seal(&ss->s.tx, b, len, hdr) || write_full(ss->fd, hdr, 4) || write_full(ss->fd, b, len + KS_TAG_LEN) ? -1 : 0;
}

static int send_sealed(sess_t *ss, uint8_t type, const uint8_t *p, size_t n)
{
    uint8_t *b = malloc(1 + n + KS_TAG_LEN);
    if (!b) return -1;
    b[0] = type;
    if (n) memcpy(b + 1, p, n);
    int r = send_sealed_buf(ss, b, 1 + n);
    free(b);
    return r;
}

// The log as {"text":"..."}, built in `big` (this session's receive buffer, free until the next
// message has been read): a few KB of heap are too many on this board. The log holds no control
// bytes but newlines (logbuf.c), so escaping is \", \\ and \n. esp_pm's profile goes after it.
static int send_logs(sess_t *ss)
{
    char *raw = (char *)big + CONFIG_KS_RX_MAX / 2;
    size_t n = logbuf_read(raw, CONFIG_KS_RX_MAX / 8);
    n += power_profile(raw + n, CONFIG_KS_RX_MAX / 8);
    uint8_t *o = big;
    size_t k = 0;
    static const char head[] = "{\"text\":\"";
    o[k++] = KS_LOGS;
    memcpy(o + k, head, sizeof(head) - 1);
    k += sizeof(head) - 1;
    for (size_t i = 0; i < n; i++) {
        char c = raw[i];
        if (c == '"' || c == '\\') { o[k++] = '\\'; o[k++] = c; }
        else if (c == '\n') { o[k++] = '\\'; o[k++] = 'n'; }
        else if ((uint8_t)c >= 0x20) o[k++] = c;
    }
    o[k++] = '"';
    o[k++] = '}';
    return send_sealed_buf(ss, o, k);
}

static int send_json_sealed(sess_t *ss, uint8_t type, cJSON *j)
{
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    if (!s) return -1;
    int r = send_sealed(ss, type, (uint8_t *)s, strlen(s));
    cJSON_free(s);
    return r;
}

static void ota_stop(sess_t *ss)
{
    if (!ss->ota_on) return;
    esp_ota_abort(ss->ota);
    mbedtls_sha256_free(&ss->ota_sha);
    ss->ota_on = false;
    info.ota = false;
    power_hold_fast(false);
}

static int on_set(sess_t *ss, cJSON *j)
{
    const cJSON *rot = cJSON_GetObjectItem(j, "rot"), *idle = cJSON_GetObjectItem(j, "idle"), *bright = cJSON_GetObjectItem(j, "bright"),
                *dim = cJSON_GetObjectItem(j, "dim");
    const char *id = jstr(j, "id"), *tz = jstr(j, "tz"), *lang = jstr(j, "lang");
    bool save = false, announce = false;
    if (cJSON_IsNumber(rot)) {
        int r = rot->valueint;
        if ((r == 0 || r == 90 || r == 180 || r == 270) && r != display_rotation()) {
            display_set_rotation(r);
            app_settings.rot = r;
            save = announce = true;
            ESP_LOGI(TAG, "rotation %d from Kiosko", r);
        }
    }
    if (id && settings_id_ok(id) && strcmp(id, app_settings.id)) {
        strlcpy(app_settings.id, id, sizeof(app_settings.id));
        save = announce = true;
    }
    if (tz && strlen(tz) < sizeof(app_settings.tz) && strcmp(tz, app_settings.tz)) {
        strlcpy(app_settings.tz, tz, sizeof(app_settings.tz));
        setenv("TZ", tz, 1);
        tzset();
        save = true;
    }
    if (lang && strlen(lang) < sizeof(app_settings.lang) && strcmp(lang, app_settings.lang)) {
        strlcpy(app_settings.lang, lang, sizeof(app_settings.lang));
        save = true;
    }
    if (cJSON_IsNumber(idle) && idle->valueint >= 3 && idle->valueint <= 3600 && idle->valueint != app_settings.idle) {
        app_settings.idle = idle->valueint;
        save = true;
    }
    // Brightness (0..100), saved: it stays without Kiosko and after a restart. The UI loop
    // (main.c) shows it, unless Kiosko dims the screen for now.
    if (cJSON_IsNumber(bright) && bright->valuedouble >= 0 && bright->valuedouble <= 100) {
        int b = (int)(bright->valuedouble + 0.5);
        if (b != app_settings.bright) {
            app_settings.bright = b;
            save = true;
            ESP_LOGI(TAG, "brightness %d %% from Kiosko", b);
        }
    }
    // Dimming (0.1.4): 0..100 for as long as this session lasts (night, a paused screen), -1 to
    // go back to the saved brightness. Never saved: without Kiosko the screen lights up again.
    if (cJSON_IsNumber(dim) && dim->valuedouble >= -1 && dim->valuedouble <= 100) {
        int d = dim->valuedouble < 0 ? -1 : (int)(dim->valuedouble + 0.5);
        if (d != info.dim && d < 0) ESP_LOGI(TAG, "dimming off");
        else if (d != info.dim) ESP_LOGI(TAG, "dimmed to %d %% by Kiosko", d);
        taskENTER_CRITICAL(&mux);
        info.dim = d;
        taskEXIT_CRITICAL(&mux);
    }
    if (save) settings_save();
    if (announce) net_announce();
    ui_kick();
    return send_json_sealed(ss, KS_STATE, describe(true));
}

static uint32_t parse_rgb(const char *s)
{
    uint8_t b[3];
    return s && !ks_hex_decode(s, b, 3) ? (uint32_t)b[0] << 16 | b[1] << 8 | b[2] : 0;
}

// One message of the session; <0 ends it.
static int dispatch(sess_t *ss, uint8_t type, uint8_t *p, size_t n, int64_t rx_us)
{
    if (type == KS_FRAME) {
        if (n < 5) return -1;
        power_frame_seen();
        uint32_t num = (uint32_t)p[0] << 24 | p[1] << 16 | p[2] << 8 | p[3];
        uint32_t dec = 0;
        esp_err_t r = ss->ota_on ? ESP_ERR_INVALID_STATE : display_jpeg(p + 4, n - 4, &dec);
        int64_t now = esp_timer_get_time();
        taskENTER_CRITICAL(&mux);
        if (r == ESP_OK) {
            if (info.last_frame_us) {
                float dt = (now - info.last_frame_us) / 1e6f;
                float f = dt > 0 ? 1.0f / dt : 0;
                info.fps = info.fps ? info.fps * 0.8f + f * 0.2f : f;
            }
            info.frames++;
            info.last_frame = num;
            info.last_frame_us = now;
            info.last_dec_ms = dec;
            info.last_rx_ms = rx_us / 1000;
        }
        taskEXIT_CRITICAL(&mux);
        if (r == ESP_OK) {
            app_frames_started();
            static bool noted;
            if (!noted) { noted = true; app_heap_note("first frame"); }
        }
        char a[112];
        snprintf(a, sizeof(a), "{\"n\":%lu,\"ok\":%s,\"rx\":%lu,\"dec\":%lu%s}", (unsigned long)num, r == ESP_OK ? "true" : "false",
                 (unsigned long)(rx_us / 1000), (unsigned long)dec, r == ESP_OK ? "" : ",\"err\":\"decode\"");
        if (r != ESP_OK) ESP_LOGW(TAG, "frame %lu not shown: %s", (unsigned long)num, esp_err_to_name(r));
        return send_sealed(ss, KS_ACK, (uint8_t *)a, strlen(a));
    }
    if (type == KS_OTA_DATA) {
        if (!ss->ota_on || ss->ota_off + n > ss->ota_size) return -1;
        if (esp_ota_write(ss->ota, p, n) != ESP_OK) { ota_stop(ss); return -1; }
        mbedtls_sha256_update(&ss->ota_sha, p, n);
        ss->ota_off += n;
        char a[40];
        snprintf(a, sizeof(a), "{\"off\":%lu}", (unsigned long)ss->ota_off);
        return send_sealed(ss, KS_OTA_ACK, (uint8_t *)a, strlen(a));
    }
    // The rest are JSON.
    cJSON *j = cJSON_ParseWithLength((char *)p, n);
    if (!cJSON_IsObject(j)) { cJSON_Delete(j); j = cJSON_CreateObject(); }
    int r = 0;
    switch (type) {
    case KS_PING:
        r = send_sealed(ss, KS_PONG, (const uint8_t *)"{}", 2);
        break;
    case KS_PONG:
        break;
    case KS_SET:
        r = on_set(ss, j);
        break;
    case KS_LED: {
        const cJSON *bl = cJSON_GetObjectItem(j, "blink");
        led_set(LED_KIOSKO, parse_rgb(jstr(j, "rgb")), cJSON_IsNumber(bl) ? bl->valueint : 0);
        break;
    }
    case KS_UNPAIR:
        settings_forget_pairing();
        net_announce();
        send_sealed(ss, KS_UNPAIR, (const uint8_t *)"{}", 2);
        r = -1;
        break;
    case KS_LOGS:
        r = send_logs(ss);
        break;
    case KS_OTA_BEGIN: {
        const cJSON *size = cJSON_GetObjectItem(j, "size");
        ss->ota_part = esp_ota_get_next_update_partition(NULL);
        cJSON *o = cJSON_CreateObject();
        if (ss->ota_on || web_ota_running() || !cJSON_IsNumber(size) || !ss->ota_part || size->valuedouble <= 0 ||
            size->valuedouble > ss->ota_part->size || ks_hex_decode(jstr(j, "sha256"), ss->ota_want, 32) ||
            esp_ota_begin(ss->ota_part, OTA_WITH_SEQUENTIAL_WRITES, &ss->ota) != ESP_OK) {
            cJSON_AddBoolToObject(o, "ok", false);
            cJSON_AddStringToObject(o, "err", "cannot start the update");
            r = send_json_sealed(ss, KS_OTA_DONE, o);
            break;
        }
        ss->ota_on = true;
        info.ota = true;
        power_hold_fast(true);
        ss->ota_size = (uint32_t)size->valuedouble;
        ss->ota_off = 0;
        mbedtls_sha256_init(&ss->ota_sha);
        mbedtls_sha256_starts(&ss->ota_sha, 0);
        ESP_LOGI(TAG, "OTA: %lu bytes to %s", (unsigned long)ss->ota_size, ss->ota_part->label);
        app_heap_note("OTA begin");
        cJSON_AddNumberToObject(o, "off", 0);
        r = send_json_sealed(ss, KS_OTA_ACK, o);
        break;
    }
    case KS_OTA_END: {
        cJSON *o = cJSON_CreateObject();
        uint8_t got[32];
        bool ok = false;
        const char *err = "not in an update";
        if (ss->ota_on) {
            mbedtls_sha256_finish(&ss->ota_sha, got);
            mbedtls_sha256_free(&ss->ota_sha);
            ss->ota_on = false;
            info.ota = false;
            power_hold_fast(false);
            if (ss->ota_off != ss->ota_size) { err = "short"; esp_ota_abort(ss->ota); }
            else if (!ks_equal(got, ss->ota_want, 32)) { err = "sha256 mismatch"; esp_ota_abort(ss->ota); }
            else if (esp_ota_end(ss->ota) != ESP_OK) err = "not a valid firmware image";
            else if (esp_ota_set_boot_partition(ss->ota_part) != ESP_OK) err = "cannot select it";
            else ok = true;
        }
        cJSON_AddBoolToObject(o, "ok", ok);
        if (!ok) cJSON_AddStringToObject(o, "err", err);
        r = send_json_sealed(ss, KS_OTA_DONE, o);
        if (ok) {
            ESP_LOGI(TAG, "OTA done; restarting into %s (rolls back unless it proves itself)", ss->ota_part->label);
            app_heap_note("OTA end");
            settings_mark_ota_by_kiosko();
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
        }
        break;
    }
    default:
        ESP_LOGW(TAG, "unknown message 0x%02x", type);
        break;
    }
    cJSON_Delete(j);
    return r;
}

static void run_session(sess_t *ss)
{
    taskENTER_CRITICAL(&mux);
    info.online = true;
    info.last_seen_us = esp_timer_get_time();
    info.fps = 0;
    info.dim = -1;
    taskEXIT_CRITICAL(&mux);
    ui_kick();
    ESP_LOGI(TAG, "Kiosko connected");
    app_heap_note("session up");
    if (send_json_sealed(ss, KS_STATE, describe(true))) goto out;
    int64_t state_at = esp_timer_get_time();
    for (;;) {
        // Wait for a message, a second at a time, so a silent Kiosko is noticed.
        fd_set rf;
        FD_ZERO(&rf);
        FD_SET(ss->fd, &rf);
        struct timeval tv = { .tv_sec = 1 };
        int s = select(ss->fd + 1, &rf, NULL, NULL, &tv);
        if (s < 0) break;
        if (want_resend) {
            want_resend = false;
            cJSON *o = describe(true);
            cJSON_AddBoolToObject(o, "resend", true);
            if (send_json_sealed(ss, KS_STATE, o)) break;
            state_at = esp_timer_get_time();
        }
        if (esp_timer_get_time() - state_at > STATE_EVERY_S * 1000000LL) {
            if (send_json_sealed(ss, KS_STATE, describe(true))) break;
            state_at = esp_timer_get_time();
        }
        if (s == 0) {
            if (esp_timer_get_time() - info.last_seen_us > SESSION_IDLE_S * 1000000LL) { ESP_LOGW(TAG, "Kiosko silent: closing"); break; }
            continue;
        }
        int64_t t0 = esp_timer_get_time();
        uint8_t hdr[4];
        set_timeout(ss->fd, 5000);
        // A message at full speed, from its first byte to its answer (power.c).
        power_busy_begin();
        int r = -1;
        if (read_full(ss->fd, hdr, 4)) goto msg_done;
        uint32_t L = (uint32_t)hdr[0] << 24 | hdr[1] << 16 | hdr[2] << 8 | hdr[3];
        if (L < 1 + KS_TAG_LEN || L > CONFIG_KS_RX_MAX) { ESP_LOGW(TAG, "bad length %lu", (unsigned long)L); goto msg_done; }
        if (read_full(ss->fd, big, L)) goto msg_done;
        int64_t rx = esp_timer_get_time() - t0;
        if (ks_open(&ss->s.rx, hdr, big, L)) { ESP_LOGW(TAG, "a message did not authenticate: closing"); goto msg_done; }
        info.last_seen_us = esp_timer_get_time();
        r = dispatch(ss, big[0], big + 1, L - KS_TAG_LEN - 1, rx);
    msg_done:
        power_busy_end();
        if (r < 0) break;
    }
out:
    ota_stop(ss);
    taskENTER_CRITICAL(&mux);
    info.online = false;
    info.dim = -1;
    taskEXIT_CRITICAL(&mux);
    led_release(LED_KIOSKO);
    ui_kick();
    ESP_LOGI(TAG, "Kiosko gone");
}

static void conn_task(void *arg)
{
    int fd = (int)(intptr_t)arg;
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    set_timeout(fd, 10000);

    uint8_t nk[KS_NONCE_LEN], nd[KS_NONCE_LEN];
    char want[12] = "";
    cJSON *j = recv_plain(fd, KS_HELLO);
    if (!j) goto out;
    const cJSON *proto = cJSON_GetObjectItem(j, "proto");
    const char *w = jstr(j, "want");
    if (w) strlcpy(want, w, sizeof(want));
    bool good = cJSON_IsNumber(proto) && !ks_hex_decode(jstr(j, "nonce"), nk, sizeof(nk));
    int pv = cJSON_IsNumber(proto) ? proto->valueint : 0;
    cJSON_Delete(j);
    if (!good) goto out;
    ks_random(nd, sizeof(nd));
    j = describe(false);
    char hn[2 * KS_NONCE_LEN + 1];
    ks_hex_encode(nd, sizeof(nd), hn);
    cJSON_AddStringToObject(j, "nonce", hn);
    cJSON_AddBoolToObject(j, "paired", app_settings.paired);
    cJSON_AddBoolToObject(j, "pairing", pairing_allowed());
    if (send_plain(fd, KS_INFO, j)) goto out;
    if (pv != KS_PROTO) { send_error(fd, "proto", "this screen speaks protocol 1"); goto out; }

    if (!strcmp(want, "pair")) {
        pair_flow(fd);
    } else if (!strcmp(want, "session")) {
        j = recv_plain(fd, KS_AUTH);
        if (!j) goto out;
        uint8_t mac[32], ok_mac[32];
        int bad = ks_hex_decode(jstr(j, "mac"), mac, sizeof(mac));
        cJSON_Delete(j);
        if (!app_settings.paired) { send_error(fd, "notPaired", "this screen is not paired"); goto out; }
        ks_auth_mac(app_settings.key, KS_LABEL_AUTH_K, nk, nd, app_uid, ok_mac);
        if (bad || !ks_equal(mac, ok_mac, 32)) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            send_error(fd, "badKey", "wrong key: pair again");
            goto out;
        }
        if (info.ota || web_ota_running()) { send_error(fd, "busy", "updating"); goto out; }
        // One session at a time: a new one (Kiosko coming back on a half-open link) wins.
        session_kick();
        if (xSemaphoreTake(session_lock, pdMS_TO_TICKS(5000)) != pdTRUE) { send_error(fd, "busy", "busy"); goto out; }
        sess_t *ss = calloc(1, sizeof(*ss));
        if (!ss) { xSemaphoreGive(session_lock); goto out; }
        ss->fd = fd;
        ks_session_init(&ss->s, app_settings.key, nk, nd, true);
        ks_auth_mac(app_settings.key, KS_LABEL_AUTH_D, nk, nd, app_uid, ok_mac);
        char hm[65];
        ks_hex_encode(ok_mac, 32, hm);
        j = cJSON_CreateObject();
        cJSON_AddStringToObject(j, "mac", hm);
        if (!send_plain(fd, KS_AUTH_OK, j)) {
            session_fd = fd;
            app_session_ok();
            run_session(ss);
            session_fd = -1;
        }
        mbedtls_platform_zeroize(ss, sizeof(*ss));
        free(ss);
        xSemaphoreGive(session_lock);
    }
out:
    shutdown(fd, SHUT_RDWR);
    close(fd);
    taskENTER_CRITICAL(&mux);
    conns--;
    taskEXIT_CRITICAL(&mux);
    vTaskDelete(NULL);
}

static void accept_task(void *arg)
{
    int ls = socket(AF_INET6, SOCK_STREAM, 0);
    int one = 1, zero = 0;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    setsockopt(ls, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof(zero));
    struct sockaddr_in6 a = { .sin6_family = AF_INET6, .sin6_port = htons(KS_PORT) };
    if (bind(ls, (struct sockaddr *)&a, sizeof(a)) || listen(ls, 2)) {
        ESP_LOGE(TAG, "cannot listen on %d", KS_PORT);
        vTaskDelete(NULL);
    }
    ESP_LOGI(TAG, "listening on %d", KS_PORT);
    app_server_up = true;
    app_healthy_check();
    for (;;) {
        int fd = accept(ls, NULL, NULL);
        if (fd < 0) { vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        bool room;
        taskENTER_CRITICAL(&mux);
        room = conns < MAX_CONNS;
        if (room) conns++;
        taskEXIT_CRITICAL(&mux);
        if (!room || xTaskCreate(conn_task, "ks_conn", 8192, (void *)(intptr_t)fd, 5, NULL) != pdPASS) {
            if (room) { taskENTER_CRITICAL(&mux); conns--; taskEXIT_CRITICAL(&mux); }
            close(fd);
        }
    }
}

void session_start(void)
{
    session_lock = xSemaphoreCreateMutex();
    info.dim = -1;
    big = heap_caps_malloc(CONFIG_KS_RX_MAX, MALLOC_CAP_INTERNAL);
    assert(big);
    xTaskCreate(accept_task, "ks_accept", 4096, NULL, 5, NULL);
}
