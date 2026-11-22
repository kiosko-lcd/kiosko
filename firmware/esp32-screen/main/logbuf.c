// The last few KB of the log in RAM, for `kiosko remote logs` (the USB console still gets everything).
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "app.h"

#define LOG_SIZE 6144
static char ring[LOG_SIZE];
static size_t head, used;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static vprintf_like_t prev;

static int hook(const char *fmt, va_list ap)
{
    char line[192];
    va_list cp;
    va_copy(cp, ap);
    int n = vsnprintf(line, sizeof(line), fmt, cp);
    va_end(cp);
    if (n < 0) n = 0;
    if (n > (int)sizeof(line) - 1) n = sizeof(line) - 1;
    taskENTER_CRITICAL(&mux);
    for (int i = 0; i < n && line[i]; i++) {
        // Text only: a NUL or a control byte would cut the log short where it is read.
        if ((uint8_t)line[i] < 0x20 && line[i] != '\n') continue;
        ring[head] = line[i];
        head = (head + 1) % LOG_SIZE;
        if (used < LOG_SIZE) used++;
    }
    taskEXIT_CRITICAL(&mux);
    return prev ? prev(fmt, ap) : vprintf(fmt, ap);
}

void logbuf_init(void) { prev = esp_log_set_vprintf(hook); }

size_t logbuf_read(char *out, size_t max)
{
    taskENTER_CRITICAL(&mux);
    size_t n = used < max - 1 ? used : max - 1;
    size_t start = (head + LOG_SIZE - n) % LOG_SIZE;
    for (size_t i = 0; i < n; i++) out[i] = ring[(start + i) % LOG_SIZE];
    taskEXIT_CRITICAL(&mux);
    out[n] = 0;
    // Start at a whole line.
    char *nl = n == used && used < LOG_SIZE ? out : strchr(out, '\n');
    if (nl && nl != out) memmove(out, nl + 1, strlen(nl + 1) + 1);
    return strlen(out);
}
