#pragma once
// The board layer: one header per board under boards/, chosen in menuconfig
// (Kiosko screen -> Board). A new board needs its pins and panel there; a
// panel other than the ST7789 also needs its esp_lcd driver in display.c
// (for instance the ILI9341 of the 320x240 "Cheap Yellow Display").
#include "sdkconfig.h"

#if CONFIG_KS_BOARD_WAVESHARE_C6_LCD147
#include "boards/waveshare_esp32c6_lcd147.h"
#else
#error "No board selected: idf.py menuconfig -> Kiosko screen -> Board"
#endif
