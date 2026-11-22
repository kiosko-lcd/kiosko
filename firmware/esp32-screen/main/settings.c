// Settings in NVS (namespace "kscreen"). The first boot after the Waveshare
// photo-frame firmware takes its Wi-Fi and rotation from that one's namespace
// ("fotos"), read-only: the photo frame keeps everything if it comes back.
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "mbedtls/platform_util.h"
#include "nvs_flash.h"
#include "app.h"

static const char *TAG = "settings";
#define NS "kscreen"

settings_t app_settings;
char app_uid[13];
bool app_first_boot, app_ota_by_kiosko;

bool settings_id_ok(const char *id)
{
    size_t n = strlen(id);
    if (n < 1 || n > KS_ID_MAX || id[0] == '-' || id[n - 1] == '-') return false;
    for (size_t i = 0; i < n; i++)
        if (!((id[i] >= 'a' && id[i] <= 'z') || (id[i] >= '0' && id[i] <= '9') || id[i] == '-')) return false;
    return true;
}

static void get_str(nvs_handle_t h, const char *k, char *out, size_t n)
{
    size_t len = n;
    if (nvs_get_str(h, k, out, &len) != ESP_OK) return;
    out[n - 1] = 0;
}

void settings_load(void)
{
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // Only when NVS can't be read at all: it would be lost anyway.
        ESP_ERROR_CHECK(nvs_flash_erase());
        r = nvs_flash_init();
    }
    ESP_ERROR_CHECK(r);

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(app_uid, sizeof(app_uid), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    settings_t *s = &app_settings;
    memset(s, 0, sizeof(*s));
    snprintf(s->id, sizeof(s->id), "screen-%02x%02x", mac[4], mac[5]);
    strcpy(s->tz, "UTC0");
    strcpy(s->lang, "en");
    s->idle = CONFIG_KS_IDLE_SECONDS;
    s->bright = CONFIG_KS_BRIGHTNESS;

    nvs_handle_t h;
    bool have = false;
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        have = true;
        char id[sizeof(s->id)] = "";
        get_str(h, "id", id, sizeof(id));
        if (settings_id_ok(id)) strcpy(s->id, id);
        get_str(h, "ssid", s->ssid, sizeof(s->ssid));
        get_str(h, "pass", s->pass, sizeof(s->pass));
        get_str(h, "tz", s->tz, sizeof(s->tz));
        get_str(h, "lang", s->lang, sizeof(s->lang));
        get_str(h, "peer", s->peer, sizeof(s->peer));
        nvs_get_u16(h, "rot", &s->rot);
        nvs_get_u16(h, "idle", &s->idle);
        nvs_get_u8(h, "bright", &s->bright);
        uint8_t ok = 0;
        app_ota_by_kiosko = nvs_get_u8(h, "otak", &ok) == ESP_OK && ok;
        size_t n = sizeof(s->key);
        s->paired = nvs_get_blob(h, "key", s->key, &n) == ESP_OK && n == sizeof(s->key);
        nvs_close(h);
    }
    app_first_boot = !have;
    if (app_ota_by_kiosko && nvs_open(NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, "otak");
        nvs_commit(h);
        nvs_close(h);
    }
    if (!have && nvs_open("fotos", NVS_READONLY, &h) == ESP_OK) {
        // Read-only: nothing of the photo frame's is changed.
        get_str(h, "ssid", s->ssid, sizeof(s->ssid));
        get_str(h, "pass", s->pass, sizeof(s->pass));
        nvs_get_u16(h, "rotation", &s->rot);
        nvs_close(h);
        if (s->ssid[0]) ESP_LOGI(TAG, "Wi-Fi taken from the photo-frame settings");
    }
    if (!have) settings_save();
    if (s->rot % 90 || s->rot > 270) s->rot = 0;
    if (s->idle < 3) s->idle = CONFIG_KS_IDLE_SECONDS;
    if (s->bright > 100) s->bright = CONFIG_KS_BRIGHTNESS;
    ESP_LOGI(TAG, "uid %s, id %s, rotation %u, brightness %u %%, %s", app_uid, s->id, s->rot, s->bright, s->paired ? "paired" : "not paired");
}

void settings_save(void)
{
    const settings_t *s = &app_settings;
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "id", s->id);
    nvs_set_str(h, "ssid", s->ssid);
    nvs_set_str(h, "pass", s->pass);
    nvs_set_str(h, "tz", s->tz);
    nvs_set_str(h, "lang", s->lang);
    nvs_set_str(h, "peer", s->peer);
    nvs_set_u16(h, "rot", s->rot);
    nvs_set_u16(h, "idle", s->idle);
    nvs_set_u8(h, "bright", s->bright);
    if (s->paired) nvs_set_blob(h, "key", s->key, sizeof(s->key));
    else nvs_erase_key(h, "key");
    nvs_commit(h);
    nvs_close(h);
}

void settings_mark_ota_by_kiosko(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u8(h, "otak", 1);
    nvs_commit(h);
    nvs_close(h);
}

void settings_forget_pairing(void)
{
    app_settings.paired = false;
    mbedtls_platform_zeroize(app_settings.key, sizeof(app_settings.key));
    app_settings.peer[0] = 0;
    settings_save();
    ESP_LOGW(TAG, "pairing forgotten");
}

void settings_forget_wifi(void)
{
    mbedtls_platform_zeroize(app_settings.pass, sizeof(app_settings.pass));
    app_settings.ssid[0] = 0;
    settings_save();
    ESP_LOGW(TAG, "Wi-Fi forgotten");
}
