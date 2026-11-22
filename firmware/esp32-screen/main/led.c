// The RGB LED: off unless something asks. The screen's own uses (pairing) go
// before Kiosko's (alerts), which last while its session does.
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "app.h"
#include "board.h"

typedef struct { bool on; uint32_t rgb, blink; } led_req_t;
static led_req_t req[2];
static led_strip_handle_t strip;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

static TaskHandle_t task;

// Wakes only to blink, or when asked (led_set): a steady LED lets the chip sleep.
static void led_task(void *arg)
{
    uint32_t shown = 0xFFFFFFFF;
    for (;;) {
        taskENTER_CRITICAL(&mux);
        led_req_t r = req[LED_SELF].on ? req[LED_SELF] : req[LED_KIOSKO];
        taskEXIT_CRITICAL(&mux);
        uint32_t rgb = r.on ? r.rgb : 0;
        if (r.on && r.blink && (xTaskGetTickCount() * portTICK_PERIOD_MS / r.blink) % 2) rgb = 0;
        if (rgb != shown) {
            shown = rgb;
            // At 1/8: a WS2812 at full power dazzles on a desk.
            led_strip_set_pixel(strip, 0, ((rgb >> 16) & 0xFF) / 8, ((rgb >> 8) & 0xFF) / 8, (rgb & 0xFF) / 8);
            led_strip_refresh(strip);
        }
        ulTaskNotifyTake(pdTRUE, r.on && r.blink ? pdMS_TO_TICKS(40) : portMAX_DELAY);
    }
}

void led_init(void)
{
    led_strip_config_t cfg = { .strip_gpio_num = BOARD_LED_WS2812, .max_leds = 1 };
    led_strip_rmt_config_t rmt = { .resolution_hz = 10 * 1000 * 1000 };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&cfg, &rmt, &strip));
    led_strip_clear(strip);
    xTaskCreate(led_task, "led", 2560, NULL, 3, &task);
}

void led_set(led_owner_t who, uint32_t rgb, uint32_t blink_ms)
{
    taskENTER_CRITICAL(&mux);
    req[who] = (led_req_t){ .on = rgb != 0, .rgb = rgb, .blink = blink_ms < 80 && blink_ms ? 80 : blink_ms };
    taskEXIT_CRITICAL(&mux);
    if (task) xTaskNotifyGive(task);
}

void led_release(led_owner_t who) { led_set(who, 0, 0); }
