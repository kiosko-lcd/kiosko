// Wi-Fi, mDNS/DNS-SD and the clock.
//
// The station uses the saved network; with none, or no connection within 20 s,
// the screen opens its own WPA2 network "Kiosko-<id>-setup", whose password it
// shows (so only someone in front of it can join), with the setup page at
// http://192.168.4.1 and a DNS that sends every name there (captive portal).
// Once online, it announces itself as _kiosko-screen._tcp (docs/remote-screen.md).
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "esp_app_desc.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "app.h"
#include "board.h"
#include "ks_proto.h"

static const char *TAG = "net";

static volatile net_state_t state = NET_CONNECTING;
static char ip[16] = "";
static esp_netif_t *sta_netif;
static esp_timer_handle_t retry_timer, fallback_timer;
static bool have_creds, portal_on, mdns_on, sntp_on;
static char ap_ssid[33], ap_pass[9];
static TaskHandle_t dns_task_h;

net_state_t net_state(void) { return state; }
const char *net_ip(void) { return ip; }
const char *net_ap_ssid(void) { return ap_ssid; }
const char *net_ap_pass(void) { return ap_pass; }

int net_rssi(void)
{
    wifi_ap_record_t ap;
    return state == NET_ONLINE && esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0;
}

// Power save off while frames come fast: modem sleep holds each received frame back until
// the next beacon (power.c decides). Kept for when the station (re)connects.
static volatile bool low_latency;
void net_set_low_latency(bool on)
{
    low_latency = on;
    if (state == NET_ONLINE) esp_wifi_set_ps(on ? WIFI_PS_NONE : WIFI_PS_MIN_MODEM);
}

bool net_time_ok(void) { return time(NULL) > 1700000000; }

static void set_state(net_state_t s)
{
    if (state == s) return;
    state = s;
    ui_kick();
}

// ---- captive DNS: every A question answered with the AP's address --------------

static void dns_task(void *arg)
{
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = htonl(INADDR_ANY) };
    if (s < 0 || bind(s, (struct sockaddr *)&a, sizeof(a)) < 0) { ESP_LOGW(TAG, "captive DNS not started"); vTaskDelete(NULL); }
    uint8_t buf[300];
    for (;;) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(s, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&from, &fl);
        if (n < 12 || !portal_on) continue;
        // Header: answer = question + one A record pointing back at the name (0xC00C).
        int q = 12;
        while (q < n && buf[q]) q += buf[q] + 1;
        q += 5;
        if (q > n) continue;
        buf[2] = 0x81; buf[3] = 0x80;               // response, recursion available, no error
        buf[6] = 0; buf[7] = 1;                     // one answer
        buf[8] = buf[9] = buf[10] = buf[11] = 0;
        uint8_t ans[] = { 0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 168, 4, 1 };
        memcpy(buf + q, ans, sizeof(ans));
        sendto(s, buf, q + sizeof(ans), 0, (struct sockaddr *)&from, fl);
    }
}

static void start_portal(void)
{
    if (portal_on) return;
    portal_on = true;
    // Eight digits, new each time: the screen shows them, so joining needs to be in front of it.
    snprintf(ap_pass, sizeof(ap_pass), "%08lu", (unsigned long)(esp_random() % 100000000UL));
    snprintf(ap_ssid, sizeof(ap_ssid), "Kiosko-%.19s-setup", app_settings.id);
    wifi_config_t ap = { .ap = { .channel = 1, .max_connection = 2, .authmode = WIFI_AUTH_WPA2_PSK, .pmf_cfg.required = false } };
    strlcpy((char *)ap.ap.ssid, ap_ssid, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = strlen(ap_ssid);
    strlcpy((char *)ap.ap.password, ap_pass, sizeof(ap.ap.password));
    ESP_ERROR_CHECK(esp_wifi_set_mode(have_creds ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    if (!dns_task_h) xTaskCreate(dns_task, "dns", 3072, NULL, 4, &dns_task_h);
    ESP_LOGI(TAG, "setup mode: network '%s', http://192.168.4.1", ap_ssid);
    led_set(LED_SELF, 0x8000ff, 1500);
    set_state(NET_SETUP);
}

static void stop_portal(void)
{
    if (!portal_on) return;
    portal_on = false;
    memset(ap_pass, 0, sizeof(ap_pass));
    esp_wifi_set_mode(WIFI_MODE_STA);
    led_release(LED_SELF);
}

// With the setup network open, trying the station again changes channel and drops whoever is
// on the setup page: only try while nobody is connected to it.
static void retry_cb(void *arg)
{
    if (!have_creds || state == NET_ONLINE) return;
    if (portal_on) {
        wifi_sta_list_t l;
        if (esp_wifi_ap_get_sta_list(&l) == ESP_OK && l.num > 0) {
            esp_timer_start_once(retry_timer, 60 * 1000000ULL);
            return;
        }
    }
    esp_wifi_connect();
}

static void fallback_cb(void *arg)
{
    if (state != NET_ONLINE) start_portal();
}

static void txt_update(void)
{
    char w[8], h[8], rot[8];
    snprintf(w, sizeof(w), "%d", BOARD_LCD_W);
    snprintf(h, sizeof(h), "%d", BOARD_LCD_H);
    snprintf(rot, sizeof(rot), "%d", display_rotation());
    mdns_txt_item_t txt[] = {
        { "id", app_settings.id }, { "uid", app_uid }, { "model", BOARD_MODEL },
        { "w", w }, { "h", h }, { "rot", rot }, { "fw", esp_app_get_description()->version },
        { "proto", "1" }, { "paired", app_settings.paired ? "1" : "0" },
    };
    mdns_service_txt_set("_kiosko-screen", "_tcp", txt, sizeof(txt) / sizeof(txt[0]));
}

void net_announce(void)
{
    if (!mdns_on) return;
    char host[40];
    snprintf(host, sizeof(host), "kiosko-%s", app_settings.id);
    mdns_hostname_set(host);
    mdns_instance_name_set(app_settings.id);
    if (!mdns_service_exists("_kiosko-screen", "_tcp", NULL)) {
        mdns_service_add(app_settings.id, "_kiosko-screen", "_tcp", KS_PORT, NULL, 0);
        mdns_service_add(app_settings.id, "_http", "_tcp", 80, NULL, 0);
    } else {
        mdns_service_instance_name_set("_kiosko-screen", "_tcp", app_settings.id);
        mdns_service_instance_name_set("_http", "_tcp", app_settings.id);
    }
    txt_update();
    esp_netif_set_hostname(sta_netif, host);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (have_creds) esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = data;
        ESP_LOGW(TAG, "disconnected (reason %d)", e->reason);
        ip[0] = 0;
        if (state == NET_ONLINE) {
            set_state(NET_CONNECTING);
            esp_timer_start_once(fallback_timer, 60 * 1000000ULL);
        }
        esp_timer_stop(retry_timer);
        esp_timer_start_once(retry_timer, (portal_on ? 60 : 3) * 1000000ULL);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        esp_ip4addr_ntoa(&e->ip_info.ip, ip, sizeof(ip));
        ESP_LOGI(TAG, "online, IP %s", ip);
        esp_timer_stop(fallback_timer);
        stop_portal();
        // Modem sleep unless frames are coming fast (power.c): the radio sleeps between beacons.
        esp_wifi_set_ps(low_latency ? WIFI_PS_NONE : WIFI_PS_MIN_MODEM);
        if (!sntp_on) {
            sntp_on = true;
            esp_sntp_config_t c = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
            esp_netif_sntp_init(&c);
        }
        set_state(NET_ONLINE);
        net_announce();
        app_healthy_check();
    }
}

void net_start(void)
{
    setenv("TZ", app_settings.tz, 1);
    tzset();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM)); // settings.c keeps the credentials
    // Without the country, channels 12-13 (allowed in most of Europe) are not seen.
    ESP_ERROR_CHECK(esp_wifi_set_country_code(CONFIG_KS_WIFI_COUNTRY, true));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));

    esp_timer_create_args_t r = { .callback = retry_cb, .name = "wifi_retry" };
    esp_timer_create_args_t f = { .callback = fallback_cb, .name = "wifi_fallback" };
    ESP_ERROR_CHECK(esp_timer_create(&r, &retry_timer));
    ESP_ERROR_CHECK(esp_timer_create(&f, &fallback_timer));

    ESP_ERROR_CHECK(mdns_init());
    mdns_on = true;
    char host[40];
    snprintf(host, sizeof(host), "kiosko-%s", app_settings.id);
    esp_netif_set_hostname(sta_netif, host);

    have_creds = app_settings.ssid[0] != 0;
    if (have_creds) {
        wifi_config_t sta = { 0 };
        strlcpy((char *)sta.sta.ssid, app_settings.ssid, sizeof(sta.sta.ssid));
        strlcpy((char *)sta.sta.password, app_settings.pass, sizeof(sta.sta.password));
        sta.sta.threshold.authmode = app_settings.pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
        sta.sta.pmf_cfg.capable = true;
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
        ESP_LOGI(TAG, "connecting to the saved network");
        esp_timer_start_once(fallback_timer, 20 * 1000000ULL);
        ESP_ERROR_CHECK(esp_wifi_start());
    } else {
        ESP_ERROR_CHECK(esp_wifi_start());
        start_portal();
    }
}
