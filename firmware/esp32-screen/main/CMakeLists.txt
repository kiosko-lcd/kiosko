idf_component_register(SRCS "main.c" "display.c" "settings.c" "net.c" "web.c" "session.c" "ks_proto.c" "led.c" "logbuf.c" "texts.c"
                       INCLUDE_DIRS "."
                       EMBED_TXTFILES "status.html" "setup.html"
                       REQUIRES esp_lcd esp_driver_gpio esp_driver_spi esp_wifi esp_netif esp_event esp_timer esp_http_server
                                app_update nvs_flash json mbedtls esp_app_format)
