// The panel: ST7789 over SPI, rotation by MADCTL (no cost), JPEG frames and text, and
// the backlight's brightness (LEDC PWM).
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "jpeg_decoder.h"
#include "app.h"
#include "board.h"
#include "font.h"

static const char *TAG = "display";

SemaphoreHandle_t app_gfx_lock;
uint16_t *app_fb;

static esp_lcd_panel_handle_t panel;
static SemaphoreHandle_t flush_done;
static volatile bool flushing;
static int width = BOARD_LCD_W, height = BOARD_LCD_H, rotation;

#define FB_PIXELS (BOARD_LCD_W * BOARD_LCD_H)

// ---- backlight -------------------------------------------------------------------
// PWM from the LEDC, clocked by RC_FAST and kept alive in light sleep (KEEP_ALIVE), so the
// light neither flickers nor goes out while the chip sleeps between beacons. 5 kHz, 10 bits.
// The percentage is perceived brightness: duty = pct^2 (70 % is about half the power).
#define BL_RES      LEDC_TIMER_10_BIT
#define BL_MAX      ((1 << 10) - 1)
static int brightness = -1;

static void backlight_init(void)
{
    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE, .timer_num = LEDC_TIMER_0, .duty_resolution = BL_RES,
        .freq_hz = 5000, .clk_cfg = LEDC_USE_RC_FAST_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));
    ledc_channel_config_t c = {
        .gpio_num = BOARD_LCD_BL, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0, .duty = 0, .sleep_mode = LEDC_SLEEP_MODE_KEEP_ALIVE,
        .flags.output_invert = !BOARD_LCD_BL_ON,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&c));
}

void display_set_brightness(int pct)
{
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pct == brightness) return;
    brightness = pct;
    uint32_t duty = (uint32_t)(pct * pct * BL_MAX + 5000) / 10000;
    if (pct && !duty) duty = 1;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

int display_brightness(void) { return brightness < 0 ? 0 : brightness; }

static bool on_flush_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(flush_done, &woken);
    return woken == pdTRUE;
}

void display_init(void)
{
    app_gfx_lock = xSemaphoreCreateRecursiveMutex();
    flush_done = xSemaphoreCreateBinary();
    app_fb = heap_caps_malloc(FB_PIXELS * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    assert(app_fb);

    backlight_init(); // dark until the panel shows something

    spi_bus_config_t bus = {
        .mosi_io_num = BOARD_SPI_MOSI, .miso_io_num = BOARD_SPI_MISO, .sclk_io_num = BOARD_SPI_SCLK,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = FB_PIXELS * 2,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(BOARD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .cs_gpio_num = BOARD_LCD_CS, .dc_gpio_num = BOARD_LCD_DC,
        .spi_mode = 0, .pclk_hz = BOARD_LCD_PCLK_HZ, .trans_queue_depth = 4,
        .lcd_cmd_bits = 8, .lcd_param_bits = 8,
        .on_color_trans_done = on_flush_done,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)BOARD_SPI_HOST, &io_cfg, &io));

#if BOARD_LCD_ST7789
    esp_lcd_panel_dev_config_t dev = {
        .reset_gpio_num = BOARD_LCD_RST,
        .rgb_ele_order = BOARD_LCD_BGR ? LCD_RGB_ELEMENT_ORDER_BGR : LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &dev, &panel));
#else
#error "display.c: this board's panel controller is not supported yet"
#endif
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, BOARD_LCD_INVERT));
    display_set_rotation(0);
    fb_clear(0);
    display_flush();
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    display_set_brightness(app_settings.bright);
    ESP_LOGI(TAG, "%s %dx%d ready", BOARD_MODEL, BOARD_LCD_W, BOARD_LCD_H);
}

// Kiosko's angle: the picture, turned `deg` clockwise, is what the glass shows in its
// native orientation (as Kiosko's own rotateCanvas would turn it for a USB panel). The
// panel's offset is symmetric, so mirroring keeps it; a quarter turn moves it to the other axis.
void display_set_rotation(int deg)
{
    xSemaphoreTakeRecursive(app_gfx_lock, portMAX_DELAY);
    display_flush_wait();
    bool swap = deg == 90 || deg == 270;
    bool mx = deg == 90 || deg == 180;
    bool my = deg == 180 || deg == 270;
    esp_lcd_panel_swap_xy(panel, swap);
    esp_lcd_panel_mirror(panel, mx, my);
    if (swap) {
        esp_lcd_panel_set_gap(panel, BOARD_LCD_Y_OFFSET, BOARD_LCD_X_OFFSET);
        width = BOARD_LCD_H; height = BOARD_LCD_W;
    } else {
        esp_lcd_panel_set_gap(panel, BOARD_LCD_X_OFFSET, BOARD_LCD_Y_OFFSET);
        width = BOARD_LCD_W; height = BOARD_LCD_H;
    }
    rotation = deg;
    xSemaphoreGiveRecursive(app_gfx_lock);
}

int display_rotation(void) { return rotation; }
int display_width(void) { return width; }
int display_height(void) { return height; }

void display_flush_wait(void)
{
    if (!flushing) return;
    xSemaphoreTake(flush_done, portMAX_DELAY);
    flushing = false;
}

void display_flush_start(void)
{
    display_flush_wait();
    flushing = true;
    esp_lcd_panel_draw_bitmap(panel, 0, 0, width, height, app_fb);
}

void display_flush(void)
{
    display_flush_start();
    display_flush_wait();
}

esp_err_t display_jpeg(const uint8_t *jpeg, size_t len, uint32_t *decode_ms)
{
    esp_jpeg_image_cfg_t cfg = {
        .indata = (uint8_t *)jpeg, .indata_size = len,
        .out_format = JPEG_IMAGE_FORMAT_RGB565, .flags.swap_color_bytes = 1,
    };
    esp_jpeg_image_output_t info;
    if (esp_jpeg_get_image_info(&cfg, &info) != ESP_OK) return ESP_ERR_INVALID_ARG;
    // The smallest scale (1, 1/2, 1/4, 1/8) that fits: Kiosko sends frames at size, this
    // only keeps a frame of the old size readable for the moment a rotation takes.
    int s = 0;
    while (s < 3 && (((info.width + (1 << s) - 1) >> s) > width || ((info.height + (1 << s) - 1) >> s) > height)) s++;
    int w = (info.width + (1 << s) - 1) >> s, h = (info.height + (1 << s) - 1) >> s;
    if (w > width || h > height) return ESP_ERR_INVALID_SIZE;

    xSemaphoreTakeRecursive(app_gfx_lock, portMAX_DELAY);
    display_flush_wait();
    power_busy_begin(); // full speed for the decode (the session holds it too, power.c)
    int64_t t0 = esp_timer_get_time();
    cfg.out_scale = s;
    cfg.outbuf = (uint8_t *)app_fb;
    cfg.outbuf_size = FB_PIXELS * 2;
    esp_err_t r = esp_jpeg_decode(&cfg, &info);
    if (r == ESP_OK) {
        w = info.width; h = info.height;
        if (w != width || h != height) {
            int ox = (width - w) / 2, oy = (height - h) / 2;
            for (int y = h - 1; y >= 0; y--) memmove(&app_fb[(oy + y) * width + ox], &app_fb[y * w], w * 2);
            for (int y = 0; y < height; y++) {
                if (y < oy || y >= oy + h) { memset(&app_fb[y * width], 0, width * 2); continue; }
                memset(&app_fb[y * width], 0, ox * 2);
                memset(&app_fb[y * width + ox + w], 0, (width - ox - w) * 2);
            }
        }
        if (decode_ms) *decode_ms = (uint32_t)((esp_timer_get_time() - t0) / 1000);
        display_flush_start();
    }
    power_busy_end();
    xSemaphoreGiveRecursive(app_gfx_lock);
    return r == ESP_OK ? ESP_OK : ESP_FAIL;
}

// ---- text ----------------------------------------------------------------------

static inline uint16_t be(uint16_t c) { return (c >> 8) | (c << 8); }

void fb_clear(uint16_t color)
{
    uint16_t v = be(color);
    for (int i = 0; i < width * height; i++) app_fb[i] = v;
}

void fb_rect(int x, int y, int w, int h, uint16_t color)
{
    uint16_t v = be(color);
    for (int yy = y < 0 ? 0 : y; yy < y + h && yy < height; yy++)
        for (int xx = x < 0 ? 0 : x; xx < x + w && xx < width; xx++) app_fb[yy * width + xx] = v;
}

static uint32_t utf8_next(const char **s)
{
    const uint8_t *p = (const uint8_t *)*s;
    uint32_t cp;
    int n;
    if (p[0] < 0x80) { cp = p[0]; n = 1; }
    else if ((p[0] & 0xE0) == 0xC0) { cp = p[0] & 0x1F; n = 2; }
    else if ((p[0] & 0xF0) == 0xE0) { cp = p[0] & 0x0F; n = 3; }
    else { cp = p[0] & 0x07; n = 4; }
    for (int i = 1; i < n; i++) {
        if ((p[i] & 0xC0) != 0x80) { *s += i; return '?'; }
        cp = (cp << 6) | (p[i] & 0x3F);
    }
    *s += n;
    return cp;
}

static const glyph_t *find_glyph(const font_t *f, uint32_t cp)
{
    for (int i = 0; i < f->n; i++) if (f->g[i].cp == cp) return &f->g[i];
    for (int i = 0; i < f->n; i++) if (f->g[i].cp == '?') return &f->g[i];
    return NULL;
}

static int text_width(const font_t *f, int scale, const char *s)
{
    int w = 0;
    while (*s) { const glyph_t *g = find_glyph(f, utf8_next(&s)); if (g) w += g->adv * scale; }
    return w;
}

static uint16_t blend(uint16_t bg, uint16_t fg, int a)
{
    int r = (((fg >> 11) * a) + ((bg >> 11) * (15 - a))) / 15;
    int g = ((((fg >> 5) & 0x3F) * a) + (((bg >> 5) & 0x3F) * (15 - a))) / 15;
    int b = (((fg & 0x1F) * a) + ((bg & 0x1F) * (15 - a))) / 15;
    return (r << 11) | (g << 5) | b;
}

static void draw_text(int x, int y, const font_t *f, int scale, uint16_t color, const char *s)
{
    while (*s) {
        const glyph_t *g = find_glyph(f, utf8_next(&s));
        if (!g) continue;
        const uint8_t *bits = f->bits + g->off;
        int stride = (g->w + 1) / 2;
        for (int gy = 0; gy < f->h * scale; gy++) {
            int py = y + gy;
            if (py < 0 || py >= height) continue;
            for (int gx = 0; gx < g->w * scale; gx++) {
                int px = x + gx;
                if (px < 0 || px >= width) continue;
                int sx = gx / scale, sy = gy / scale;
                uint8_t b = bits[sy * stride + sx / 2];
                int a = (sx & 1) ? (b & 0x0F) : (b >> 4);
                if (!a) continue;
                uint16_t *d = &app_fb[py * width + px];
                *d = be(blend(be(*d), color, a));
            }
        }
        x += g->adv * scale;
    }
}

int fb_text_height(txt_size_t size)
{
    switch (size) {
    case TXT_TINY: return font_tiny.h;
    case TXT_SMALL: return font_small.h;
    case TXT_BIG: return font_big.h;
    default: return font_big.h * 2;
    }
}

// A text that doesn't fit steps down a size (huge -> big -> small -> tiny).
int fb_text_center(int y, txt_size_t size, uint16_t color, const char *utf8)
{
    const font_t *fonts[] = { &font_tiny, &font_small, &font_big, &font_big };
    const int scales[] = { 1, 1, 1, 2 };
    int i = (int)size;
    while (i > 0 && text_width(fonts[i], scales[i], utf8) > width - 8) i--;
    int x = (width - text_width(fonts[i], scales[i], utf8)) / 2;
    draw_text(x < 0 ? 0 : x, y, fonts[i], scales[i], color, utf8);
    return y + fb_text_height(size);
}
