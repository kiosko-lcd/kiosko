#pragma once
// Kiosko remote screen firmware: what the modules share.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

#ifndef CONFIG_KS_TEST_PAIR_CODE
#define CONFIG_KS_TEST_PAIR_CODE "" // an empty string is left out of sdkconfig.h
#endif

// ---- settings.c: NVS namespace "kscreen" -----------------------------------
#define KS_ID_MAX 24
typedef struct {
    char id[KS_ID_MAX + 1];  // user's name for it: [a-z0-9-], 1..24; the mDNS host is kiosko-<id>
    char ssid[33];
    char pass[65];
    char tz[48];             // POSIX TZ, e.g. "CET-1CEST,M3.5.0,M10.5.0/3"
    char lang[6];            // "en", "es", "de" (others fall back to English)
    char peer[48];           // who it is paired with, as Kiosko said (shown, not trusted)
    uint16_t rot;            // 0/90/180/270: the screen's own, when no Kiosko says otherwise
    uint16_t idle;           // seconds without Kiosko before the idle page
    uint8_t bright;          // backlight, 0..100 (perceived); Kiosko or the setup page set it
    bool paired;
    uint8_t key[32];         // the pairing key (NVS; see the docs about NVS encryption)
} settings_t;
extern settings_t app_settings;
extern char app_uid[13];      // from the factory MAC: stable, 12 hex digits
extern bool app_first_boot;   // no settings of its own yet: it just replaced another firmware
extern bool app_ota_by_kiosko; // the running image came by Kiosko's OTA (read once at boot)
void settings_mark_ota_by_kiosko(void);

void settings_load(void);
void settings_save(void);
void settings_forget_pairing(void);
void settings_forget_wifi(void);
bool settings_id_ok(const char *id);

// ---- display.c ----------------------------------------------------------------
// Full-screen framebuffer (RGB565 big-endian) under app_gfx_lock.
extern SemaphoreHandle_t app_gfx_lock;
extern uint16_t *app_fb;
void display_init(void);
void display_set_rotation(int deg);
int display_rotation(void);
int display_width(void);
int display_height(void);
void display_flush(void);               // sends app_fb and waits for the DMA
void display_flush_start(void);         // sends app_fb, returns at once
void display_flush_wait(void);
// Decodes a baseline JPEG into app_fb (centred, black around if smaller) and starts the flush.
esp_err_t display_jpeg(const uint8_t *jpeg, size_t len, uint32_t *decode_ms);
// Backlight 0..100 (perceived brightness; 0 = off), as shown now. It does not save:
// app_settings.bright is the saved one (a future night dimming changes only this).
void display_set_brightness(int pct);
int display_brightness(void);
typedef enum { TXT_TINY, TXT_SMALL, TXT_BIG, TXT_HUGE } txt_size_t;
void fb_clear(uint16_t color);
void fb_rect(int x, int y, int w, int h, uint16_t color);
int fb_text_center(int y, txt_size_t size, uint16_t color, const char *utf8); // returns y below
int fb_text_height(txt_size_t size);
#define RGB565(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

// ---- led.c ---------------------------------------------------------------------
void led_init(void);
// rgb 0xRRGGBB (0 = off); blink_ms 0 = steady. `owner`: Kiosko's request or the screen's own.
typedef enum { LED_SELF, LED_KIOSKO } led_owner_t;
void led_set(led_owner_t who, uint32_t rgb, uint32_t blink_ms);
void led_release(led_owner_t who);

// ---- net.c ---------------------------------------------------------------------
typedef enum { NET_CONNECTING, NET_ONLINE, NET_SETUP } net_state_t;
void net_start(void);
net_state_t net_state(void);
const char *net_ip(void);
int net_rssi(void);
const char *net_ap_ssid(void);
const char *net_ap_pass(void);   // WPA2 password of the setup network, shown on the screen
bool net_time_ok(void);
void net_announce(void);         // (re)publishes the mDNS service and its TXT
void net_set_low_latency(bool on); // Wi-Fi power save off (true) or modem sleep (false)

// ---- power.c: power management, adaptive Wi-Fi power save, the chip's temperature --
void power_init(void);
void power_busy_begin(void);     // CPU at full speed, no light sleep (a frame); nests
void power_busy_end(void);
void power_frame_seen(void);     // a frame arrived: power save goes off while they come fast
void power_hold_fast(bool on);   // power save off for as long as held (an OTA)
bool power_fast(void);
float power_temp_c(void);        // the chip's own sensor, °C; NAN if none
int power_sleep_pct(void);       // % of the time since boot in light sleep; -1 if unknown
size_t power_profile(char *out, size_t max); // esp_pm's time per mode and its locks, as text

// ---- web.c: the read-only status page, and the setup page on the AP only -------
void web_start(void);
bool web_ota_running(void);

// ---- session.c: the protocol server (docs/remote-screen.md) ---------------------
typedef struct {
    bool online;          // a Kiosko holds an authenticated session now
    bool pairing;         // a code is on the screen
    char code[7];
    char pair_peer[48];
    int64_t pair_until_us;
    int64_t window_until_us; // pairing open on a paired screen (BOOT pressed)
    uint32_t frames, last_frame;
    int64_t last_frame_us, last_seen_us;
    float fps;
    uint32_t last_dec_ms, last_rx_ms;
    bool ota;
} session_info_t;
void session_start(void);
void session_get(session_info_t *out);
void session_open_window(void);  // BOOT short press on a paired screen
void session_cancel_pairing(void);
void session_kick(void);         // drops the Kiosko session (after unpairing)
void session_request_resend(void); // the screen drew over Kiosko's frame: ask for it again

// ---- main.c ----------------------------------------------------------------------
void ui_kick(void);              // something changed: repaint the idle/status page now
void app_healthy_check(void);    // net.c and session.c call it as they come up
extern volatile bool app_server_up;
void app_session_ok(void);       // an authenticated Kiosko session is up
bool app_showing_frames(void);
void app_frames_started(void);

// ---- logbuf.c ---------------------------------------------------------------------
void logbuf_init(void);
size_t logbuf_read(char *out, size_t max); // the latest lines

// Translated device texts (en, es, de) for the screen's own pages.
const char *T(const char *key);
