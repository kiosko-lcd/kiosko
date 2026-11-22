// The screen's own words, in the language Kiosko says (en, es, de; others: English).
#include <string.h>
#include "app.h"

typedef struct { const char *key, *en, *es, *de; } text_t;
static const text_t texts[] = {
    { "waiting", "Waiting for Kiosko", "Esperando a Kiosko", "Warte auf Kiosko" },
    { "connected", "Kiosko connected", "Kiosko conectado", "Kiosko verbunden" },
    { "unpaired1", "Not paired yet:", "Sin emparejar:", "Noch nicht gekoppelt:" },
    { "unpaired2", "add it in Kiosko", "añádela en Kiosko", "in Kiosko hinzufügen" },
    { "window", "Pairing open", "Emparejamiento abierto", "Kopplung offen" },
    { "window2", "pair it from Kiosko", "empareja desde Kiosko", "in Kiosko koppeln" },
    { "pairing", "Pairing code", "Código de emparejamiento", "Kopplungscode" },
    { "pairing2", "Type it in Kiosko", "Escríbelo en Kiosko", "In Kiosko eingeben" },
    { "connecting", "Connecting to Wi-Fi…", "Conectando a la Wi-Fi…", "Verbinde mit WLAN…" },
    { "setup", "Wi-Fi setup", "Configurar la Wi-Fi", "WLAN einrichten" },
    { "join", "Join the network", "Conéctate a la red", "Verbinde dich mit" },
    { "password", "Password", "Contraseña", "Passwort" },
    { "open", "Then open", "Después abre", "Dann öffne" },
    { "hold", "Keep holding BOOT", "Mantén pulsado BOOT", "BOOT gedrückt halten" },
    { "hold5", "5 s: forget pairing", "5 s: olvidar emparejamiento", "5 s: Kopplung vergessen" },
    { "hold10", "10 s: also forget Wi-Fi", "10 s: olvidar también la Wi-Fi", "10 s: auch WLAN vergessen" },
    { "forgot", "Pairing forgotten", "Emparejamiento olvidado", "Kopplung vergessen" },
    { "forgotall", "Pairing and Wi-Fi forgotten", "Emparejamiento y Wi-Fi olvidados", "Kopplung und WLAN vergessen" },
    { "updating", "Updating firmware…", "Actualizando el firmware…", "Firmware wird aktualisiert…" },
};

const char *T(const char *key)
{
    const char *l = app_settings.lang;
    for (size_t i = 0; i < sizeof(texts) / sizeof(texts[0]); i++) {
        if (strcmp(texts[i].key, key)) continue;
        if (!strncmp(l, "es", 2)) return texts[i].es;
        if (!strncmp(l, "de", 2)) return texts[i].de;
        return texts[i].en;
    }
    return key;
}
