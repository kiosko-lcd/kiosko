// HTTP on port 80. On the home network: a read-only status page and
// /status.json, with nothing secret and nothing that changes state. On the
// setup network (the screen's own WPA2 AP, whose password is on the glass):
// the setup page (Wi-Fi, name, time zone) and a firmware upload.
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/param.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "app.h"
#include "board.h"

static const char *TAG = "web";

extern const char status_html[] asm("_binary_status_html_start");
extern const char setup_html[] asm("_binary_setup_html_start");

static volatile bool ota_running;
bool web_ota_running(void) { return ota_running; }

// Whether the request came in through the setup network (its address is 192.168.4.1).
static bool on_ap(httpd_req_t *req)
{
    struct sockaddr_in6 a;
    socklen_t l = sizeof(a);
    if (getsockname(httpd_req_to_sockfd(req), (struct sockaddr *)&a, &l) != 0) return false;
    uint32_t v4;
    if (a.sin6_family == AF_INET) v4 = ((struct sockaddr_in *)&a)->sin_addr.s_addr;
    else memcpy(&v4, &a.sin6_addr.un.u32_addr[3], 4); // IPv4-mapped
    return v4 == htonl(0xC0A80401);
}

static esp_err_t send_json(httpd_req_t *req, cJSON *j)
{
    char *s = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t r = httpd_resp_sendstr(req, s ? s : "{}");
    cJSON_free(s);
    return r;
}

static esp_err_t send_error(httpd_req_t *req, const char *status, const char *msg)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    char b[160];
    snprintf(b, sizeof(b), "{\"error\":\"%s\"}", msg);
    return httpd_resp_sendstr(req, b);
}

static esp_err_t h_index(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    // No framing by other pages, no scripts but its own.
    httpd_resp_set_hdr(req, "Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return httpd_resp_sendstr(req, on_ap(req) ? setup_html : status_html);
}

static esp_err_t h_status(httpd_req_t *req)
{
    session_info_t si;
    session_get(&si);
    int64_t now = esp_timer_get_time();
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "id", app_settings.id);
    cJSON_AddStringToObject(j, "uid", app_uid);
    cJSON_AddStringToObject(j, "model", BOARD_MODEL);
    cJSON_AddStringToObject(j, "fw", esp_app_get_description()->version);
    cJSON_AddNumberToObject(j, "proto", 1);
    cJSON_AddNumberToObject(j, "w", display_width());
    cJSON_AddNumberToObject(j, "h", display_height());
    cJSON_AddNumberToObject(j, "rot", display_rotation());
    cJSON_AddBoolToObject(j, "paired", app_settings.paired);
    cJSON_AddBoolToObject(j, "kiosko", si.online);
    cJSON_AddBoolToObject(j, "pairing", si.pairing);
    cJSON_AddNumberToObject(j, "frames", si.frames);
    cJSON_AddNumberToObject(j, "fps", si.online ? (int)(si.fps * 10 + 0.5f) / 10.0 : 0);
    cJSON_AddNumberToObject(j, "lastFrameAgoMs", si.last_frame_us ? (double)((now - si.last_frame_us) / 1000) : -1);
    cJSON_AddNumberToObject(j, "decodeMs", si.last_dec_ms);
    cJSON_AddStringToObject(j, "ip", net_ip());
    cJSON_AddNumberToObject(j, "rssi", net_rssi());
    cJSON_AddNumberToObject(j, "uptime", (double)(now / 1000000));
    cJSON_AddNumberToObject(j, "heap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(j, "heapMin", heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(j, "heapLargest", heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    cJSON_AddStringToObject(j, "partition", esp_ota_get_running_partition()->label);
    // "pending" while a new firmware is on trial (it rolls back unless it proves itself), then "valid".
    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK)
        cJSON_AddStringToObject(j, "otaState", st == ESP_OTA_IMG_PENDING_VERIFY ? "pending" : st == ESP_OTA_IMG_VALID ? "valid" : "other");
    cJSON_AddBoolToObject(j, "timeOk", net_time_ok());
    float t = power_temp_c();
    if (!isnan(t)) cJSON_AddNumberToObject(j, "tempC", roundf(t * 10) / 10);
    cJSON_AddNumberToObject(j, "bright", app_settings.bright);
    cJSON_AddStringToObject(j, "wifiPs", power_fast() ? "off" : "modem");
    int sl = power_sleep_pct();
    if (sl >= 0) cJSON_AddNumberToObject(j, "sleepPct", sl);
    if (on_ap(req)) cJSON_AddStringToObject(j, "ssid", app_settings.ssid); // the setup page fills it in
    return send_json(req, j);
}

// ---- setup network only ------------------------------------------------------------

static esp_err_t h_scan(httpd_req_t *req)
{
    if (!on_ap(req)) return send_error(req, "404 Not Found", "not here");
    wifi_scan_config_t sc = { 0 };
    uint16_t n = 20;
    wifi_ap_record_t *recs = calloc(n, sizeof(*recs));
    cJSON *j = cJSON_CreateArray();
    if (recs && esp_wifi_scan_start(&sc, true) == ESP_OK && esp_wifi_scan_get_ap_records(&n, recs) == ESP_OK) {
        for (int i = 0; i < n; i++) {
            if (!recs[i].ssid[0]) continue;
            cJSON *o = cJSON_CreateObject();
            cJSON_AddStringToObject(o, "ssid", (char *)recs[i].ssid);
            cJSON_AddNumberToObject(o, "rssi", recs[i].rssi);
            cJSON_AddBoolToObject(o, "open", recs[i].authmode == WIFI_AUTH_OPEN);
            cJSON_AddItemToArray(j, o);
        }
    }
    free(recs);
    return send_json(req, j);
}

static void reboot_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(800));
    esp_restart();
}

static esp_err_t h_save(httpd_req_t *req)
{
    if (!on_ap(req)) return send_error(req, "404 Not Found", "not here");
    if (req->content_len > 1024) return send_error(req, "413 Content Too Large", "too long");
    char buf[1025];
    int got = 0;
    while (got < (int)req->content_len) {
        int r = httpd_req_recv(req, buf + got, req->content_len - got);
        if (r <= 0) return send_error(req, "400 Bad Request", "no body");
        got += r;
    }
    buf[got] = 0;
    cJSON *j = cJSON_Parse(buf);
    if (!j) return send_error(req, "400 Bad Request", "JSON expected");
    const cJSON *ssid = cJSON_GetObjectItem(j, "ssid"), *pass = cJSON_GetObjectItem(j, "pass"),
                *id = cJSON_GetObjectItem(j, "id"), *tz = cJSON_GetObjectItem(j, "tz"), *bright = cJSON_GetObjectItem(j, "bright");
    if (!cJSON_IsString(ssid) || !ssid->valuestring[0] || strlen(ssid->valuestring) > 32 ||
        (pass && (!cJSON_IsString(pass) || strlen(pass->valuestring) > 64 || (pass->valuestring[0] && strlen(pass->valuestring) < 8))) ||
        (id && (!cJSON_IsString(id) || !settings_id_ok(id->valuestring))) ||
        (tz && (!cJSON_IsString(tz) || strlen(tz->valuestring) >= sizeof(app_settings.tz))) ||
        (bright && (!cJSON_IsNumber(bright) || bright->valuedouble < 0 || bright->valuedouble > 100))) {
        cJSON_Delete(j);
        return send_error(req, "400 Bad Request", "check the fields: network 1-32 characters, password empty or 8-64, name a-z 0-9 -");
    }
    // An empty password keeps the saved one for the same network; for another one it means an open network.
    bool same = !strcmp(app_settings.ssid, ssid->valuestring);
    strlcpy(app_settings.ssid, ssid->valuestring, sizeof(app_settings.ssid));
    if (pass && pass->valuestring[0]) strlcpy(app_settings.pass, pass->valuestring, sizeof(app_settings.pass));
    else if (!same) app_settings.pass[0] = 0;
    if (id) strlcpy(app_settings.id, id->valuestring, sizeof(app_settings.id));
    if (tz && tz->valuestring[0]) strlcpy(app_settings.tz, tz->valuestring, sizeof(app_settings.tz));
    if (bright) app_settings.bright = (uint8_t)(bright->valuedouble + 0.5);
    cJSON_Delete(j);
    settings_save();
    ESP_LOGI(TAG, "setup saved; restarting");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    xTaskCreate(reboot_task, "reboot", 2048, NULL, 5, NULL);
    return ESP_OK;
}

static esp_err_t h_ota(httpd_req_t *req)
{
    if (!on_ap(req)) return send_error(req, "404 Not Found", "not here");
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (!part || req->content_len == 0 || req->content_len > part->size) return send_error(req, "400 Bad Request", "size");
    esp_ota_handle_t ota;
    if (esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &ota) != ESP_OK) return send_error(req, "500 Internal Server Error", "cannot start");
    ota_running = true;
    ESP_LOGI(TAG, "OTA from the setup page: %d bytes to %s", req->content_len, part->label);
    char *buf = malloc(4096);
    int left = req->content_len;
    esp_err_t r = buf ? ESP_OK : ESP_ERR_NO_MEM;
    while (r == ESP_OK && left > 0) {
        int n = httpd_req_recv(req, buf, MIN(left, 4096));
        if (n == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (n <= 0) { r = ESP_FAIL; break; }
        r = esp_ota_write(ota, buf, n);
        left -= n;
    }
    free(buf);
    ota_running = false;
    if (r != ESP_OK) { esp_ota_abort(ota); return send_error(req, "400 Bad Request", "upload failed"); }
    if (esp_ota_end(ota) != ESP_OK) return send_error(req, "400 Bad Request", "not a valid firmware image");
    esp_ota_set_boot_partition(part);
    httpd_resp_sendstr(req, "{\"ok\":true}");
    xTaskCreate(reboot_task, "reboot", 2048, NULL, 5, NULL);
    return ESP_OK;
}

// Phones probe a URL to find a captive portal: on the setup network everything leads to the page.
static esp_err_t h_404(httpd_req_t *req, httpd_err_code_t err)
{
    if (on_ap(req)) {
        httpd_resp_set_status(req, "302 Found");
        httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
        return httpd_resp_send(req, NULL, 0);
    }
    return send_error(req, "404 Not Found", "not found");
}

void web_start(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.stack_size = 6144;
    cfg.max_open_sockets = 4;
    cfg.lru_purge_enable = true;
    cfg.recv_wait_timeout = 15;
    httpd_handle_t srv;
    ESP_ERROR_CHECK(httpd_start(&srv, &cfg));
    const httpd_uri_t routes[] = {
        { "/", HTTP_GET, h_index, NULL },
        { "/status.json", HTTP_GET, h_status, NULL },
        { "/setup/scan", HTTP_GET, h_scan, NULL },
        { "/setup/save", HTTP_POST, h_save, NULL },
        { "/setup/ota", HTTP_POST, h_ota, NULL },
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) ESP_ERROR_CHECK(httpd_register_uri_handler(srv, &routes[i]));
    httpd_register_err_handler(srv, HTTPD_404_NOT_FOUND, h_404);
}
