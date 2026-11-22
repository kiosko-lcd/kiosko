#pragma once
// Waveshare ESP32-C6-LCD-1.47: ESP32-C6FH8 (8 MB flash, no PSRAM), ST7789 172x320,
// WS2812 RGB LED, microSD (unused here), BOOT button.
// Source: https://www.waveshare.com/wiki/ESP32-C6-LCD-1.47
#define BOARD_MODEL         "waveshare-esp32c6-lcd-1.47"

#define BOARD_LCD_ST7789    1
#define BOARD_SPI_HOST      SPI2_HOST
#define BOARD_SPI_MOSI      6
#define BOARD_SPI_SCLK      7
#define BOARD_SPI_MISO      5   // only the SD card uses it; the bus is shared
#define BOARD_LCD_CS        14
#define BOARD_LCD_DC        15
#define BOARD_LCD_RST       21
#define BOARD_LCD_BL        22
#define BOARD_LCD_BL_ON     1
#define BOARD_LCD_PCLK_HZ   (40 * 1000 * 1000)
#define BOARD_LCD_W         172 // native: portrait
#define BOARD_LCD_H         320
#define BOARD_LCD_X_OFFSET  34  // the 172 px glass sits centred in the ST7789's 240 columns
#define BOARD_LCD_Y_OFFSET  0
#define BOARD_LCD_INVERT    1
#define BOARD_LCD_BGR       0

#define BOARD_LED_WS2812    8   // GPIO of the RGB LED
#define BOARD_BUTTON        9   // BOOT, active low
