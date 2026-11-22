// The panel: ST7789 over SPI, rotation by MADCTL (no cost), JPEG frames and text, and
// the backlight's brightness (LEDC PWM).
//
// No framebuffer: a full-screen one (110 KB) left the heap too short for the Wi-Fi's
// buffers. Everything goes to the panel in bands of 16 rows, from two DMA buffers that
// alternate (one is filled while the other is sent): JPEG frames straight from the ROM
// decoder, one MCU row at a time, and the screen's own pages, painted band by band
// (display_paint).
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
#include "rom/tjpgd.h"
#include "app.h"
#include "board.h"
#include "font.h"

static const char *TAG = "display";

SemaphoreHandle_t app_gfx_lock;

static esp_lcd_panel_handle_t panel;
static SemaphoreHandle_t flush_done;  // counting: one per band the DMA has sent
static int pending;                   // bands queued and not seen done yet
static int width = BOARD_LCD_W, height = BOARD_LCD_H, rotation;

#define MAX_DIM      (BOARD_LCD_W > BOARD_LCD_H ? BOARD_LCD_W : BOARD_LCD_H)
#ifndef BAND_ROWS
#define BAND_ROWS    16              // a JPEG MCU row is 8 or 16 rows
#endif
#define BAND_PIXELS  (MAX_DIM * BAND_ROWS)
static uint16_t *bands[2];           // RGB565 big-endian, DMA-capable
static int band_next;

// The band being painted: rows [band_y, band_y + band_h) of the screen, `band_w` wide.
static uint16_t *bp;
static int band_y, band_h, band_w;

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

// The next of the two band buffers. esp_lcd sends a band's window commands only once the
// band before has gone out, so by the time a band is queued the buffer before it is free.
static uint16_t *band_buffer(void)
{
    uint16_t *b = bands[band_next];
    band_next ^= 1;
    return b;
}

static void band_send(int x, int y, int w, int h, uint16_t *buf)
{
    pending++;
    esp_lcd_panel_draw_bitmap(panel, x, y, x + w, y + h, buf);
}

void display_init(void)
{
    app_gfx_lock = xSemaphoreCreateRecursiveMutex();
    flush_done = xSemaphoreCreateCounting(64, 0);
    for (int i = 0; i < 2; i++) {
        bands[i] = heap_caps_malloc(BAND_PIXELS * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        assert(bands[i]);
    }

    backlight_init(); // dark until the panel shows something

    spi_bus_config_t bus = {
        .mosi_io_num = BOARD_SPI_MOSI, .miso_io_num = BOARD_SPI_MISO, .sclk_io_num = BOARD_SPI_SCLK,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = BAND_PIXELS * 2,
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
    display_clear(0);
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
    while (pending > 0) {
        xSemaphoreTake(flush_done, portMAX_DELAY);
        pending--;
    }
}

void display_paint(void (*fn)(void *ctx), void *ctx)
{
    xSemaphoreTakeRecursive(app_gfx_lock, portMAX_DELAY);
    for (int y = 0; y < height; y += BAND_ROWS) {
        bp = band_buffer();
        band_y = y;
        band_w = width;
        band_h = height - y < BAND_ROWS ? height - y : BAND_ROWS;
        fn(ctx);
        band_send(0, y, width, band_h, bp);
    }
    display_flush_wait();
    bp = NULL;
    xSemaphoreGiveRecursive(app_gfx_lock);
}

static void clear_cb(void *ctx) { fb_clear(*(uint16_t *)ctx); }

void display_clear(uint16_t color)
{
    display_paint(clear_cb, &color);
}

// ---- JPEG: the ROM's TJpgDec, its output sent one MCU row at a time ------------------

typedef struct {
    const uint8_t *in;
    size_t len, off;
    int ox, oy, w;        // where the picture goes, and its (scaled) width
    int top, rows;        // the MCU row being gathered in bp
} jpeg_job_t;

static uint8_t jd_work[3100]; // TJpgDec's pool (the size esp_jpeg uses), static: no heap per frame

static UINT jd_in(JDEC *jd, BYTE *buf, UINT n)
{
    jpeg_job_t *j = jd->device;
    if (j->off + n > j->len) n = j->len - j->off;
    if (buf) memcpy(buf, j->in + j->off, n);
    j->off += n;
    return n;
}

static void jpeg_row_send(jpeg_job_t *j)
{
    if (!j->rows) return;
    band_send(j->ox, j->oy + j->top, j->w, j->rows, bp);
    bp = band_buffer();
    j->rows = 0;
}

// One MCU (RGB888 from the ROM build): into the band; a new MCU row sends the last one.
static UINT jd_out(JDEC *jd, void *bitmap, JRECT *r)
{
    jpeg_job_t *j = jd->device;
    if (r->top != j->top) {
        jpeg_row_send(j);
        j->top = r->top;
    }
    const uint8_t *px = bitmap;
    for (int y = r->top; y <= r->bottom; y++) {
        uint16_t *d = &bp[(y - j->top) * j->w];
        for (int x = r->left; x <= r->right; x++, px += 3) {
            if (x >= j->w || y - j->top >= BAND_ROWS) continue;
            uint16_t c = ((px[0] & 0xF8) << 8) | ((px[1] & 0xFC) << 3) | (px[2] >> 3);
            d[x] = (c >> 8) | (c << 8);
        }
    }
    int rows = r->bottom - j->top + 1;
    if (rows > j->rows) j->rows = rows;
    return 1;
}

esp_err_t display_jpeg(const uint8_t *jpeg, size_t len, uint32_t *decode_ms)
{
    xSemaphoreTakeRecursive(app_gfx_lock, portMAX_DELAY);
    power_busy_begin(); // full speed for the decode (the session holds it too, power.c)
    int64_t t0 = esp_timer_get_time();
    jpeg_job_t j = { .in = jpeg, .len = len, .top = -1 };
    JDEC jd;
    esp_err_t r = ESP_FAIL;
    if (jd_prepare(&jd, jd_in, jd_work, sizeof(jd_work), &j) != JDR_OK) { r = ESP_ERR_INVALID_ARG; goto out; }
    // The smallest scale (1, 1/2, 1/4, 1/8) that fits: Kiosko sends frames at size, this
    // only keeps a frame of the old size readable for the moment a rotation takes.
    int s = 0;
    while (s < 3 && (((jd.width + (1 << s) - 1) >> s) > (unsigned)width || ((jd.height + (1 << s) - 1) >> s) > (unsigned)height)) s++;
    int w = (jd.width + (1 << s) - 1) >> s, h = (jd.height + (1 << s) - 1) >> s;
    if (w > width || h > height || ((8 * jd.msy) >> s) > BAND_ROWS) { r = ESP_ERR_INVALID_SIZE; goto out; }
    if (w != width || h != height) display_clear(0); // black around a smaller picture
    j.ox = (width - w) / 2;
    j.oy = (height - h) / 2;
    j.w = w;
    display_flush_wait();
    bp = band_buffer();
    if (jd_decomp(&jd, jd_out, s) == JDR_OK) {
        jpeg_row_send(&j); // the last row; the DMA finishes it while the ACK goes
        r = ESP_OK;
    }
    bp = NULL;
    if (decode_ms) *decode_ms = (uint32_t)((esp_timer_get_time() - t0) / 1000);
out:
    power_busy_end();
    xSemaphoreGiveRecursive(app_gfx_lock);
    return r;
}

// ---- text ----------------------------------------------------------------------

static inline uint16_t be(uint16_t c) { return (c >> 8) | (c << 8); }

// These paint into the band being painted (display_paint), clipped to it.
void fb_clear(uint16_t color)
{
    uint16_t v = be(color);
    for (int i = 0; i < band_w * band_h; i++) bp[i] = v;
}

void fb_rect(int x, int y, int w, int h, uint16_t color)
{
    uint16_t v = be(color);
    int y0 = y < band_y ? band_y : y, y1 = y + h < band_y + band_h ? y + h : band_y + band_h;
    for (int yy = y0; yy < y1; yy++)
        for (int xx = x < 0 ? 0 : x; xx < x + w && xx < width; xx++) bp[(yy - band_y) * band_w + xx] = v;
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
        // Only the glyph's rows in this band.
        int gy0 = band_y - y > 0 ? band_y - y : 0, gy1 = band_y + band_h - y < f->h * scale ? band_y + band_h - y : f->h * scale;
        for (int gy = gy0; gy < gy1; gy++) {
            int py = y + gy;
            for (int gx = 0; gx < g->w * scale; gx++) {
                int px = x + gx;
                if (px < 0 || px >= width) continue;
                int sx = gx / scale, sy = gy / scale;
                uint8_t b = bits[sy * stride + sx / 2];
                int a = (sx & 1) ? (b & 0x0F) : (b >> 4);
                if (!a) continue;
                uint16_t *d = &bp[(py - band_y) * band_w + px];
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
