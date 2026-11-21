# Kiosko in Home Assistant

Kiosko can show up in [Home Assistant](https://www.home-assistant.io/) as a
device per screen, over MQTT, so your automations can drive the panels. (To
show Home Assistant *on* the panels, the other way round, install the
[kiosko-plugin-homeassistant](https://github.com/kiosko-lcd/kiosko-plugin-homeassistant)
plugin.)

Each screen gets:

| Entity | What it does |
|---|---|
| `select` **Page** | *Auto* (the screen's own rotation) or one of its pages, pinned until you choose *Auto* again. |
| `sensor` **Page shown** | The page on the panel now. |
| `switch` **Display** | Off: the panel goes black until it is switched on again. Not saved: a restart turns it back on. |
| `button` **Play: …** | One per interlude of the screen: plays it now. |

And Kiosko itself is one more device, **Kiosko**, for its full-screen
alerts (see [plugins.md](plugins.md#alerts)):

| Entity | What it does |
|---|---|
| `sensor` **Alert** | The title of the highest alert, or `—`; its `level`, `text`, `source` and `detail` (when it has them), `id`, `since` and how many there are (`count`) as attributes. |
| `button` **Acknowledge alerts** | Marks every alert that can be dismissed as seen. |

One button for all of them, not one per alert: alerts come and go, and an
entity per alert could not be put on a dashboard or in an automation
beforehand. For a single one, call the API (below).

While Kiosko is not running they show as unavailable.

## Setting it up

1. Home Assistant needs an MQTT broker and its MQTT integration. The usual
   way: *Settings → Add-ons → Mosquitto broker*, start it, and accept the MQTT
   integration Home Assistant then offers.
2. A user for Kiosko: with the Mosquitto add-on any Home Assistant user can
   log in to the broker; a dedicated one (*Settings → People → Users*, not an
   administrator) is better.
3. In Kiosko: *Settings → Home Assistant*, switch it on, and give the broker
   (`mqtt://homeassistant.local:1883`, or `mqtts://…:8883` for TLS), the user
   and the password. The card says *connected* when it is.

The screens appear in Home Assistant at once, under *Settings → Devices &
services → MQTT*, named "Kiosko" and the screen's name. Renaming a screen or
its pages in Kiosko renames them there; removing them removes them.

In the config file it is the `homeassistant` section:

```json
"homeassistant": {
  "enabled": true,
  "broker": "mqtt://homeassistant.local:1883",
  "username": "kiosko",
  "password": "…",
  "nodeId": "kiosko",
  "discoveryPrefix": "homeassistant"
}
```

`nodeId` goes in the topics (`kiosko/<nodeId>/…`): change it if two machines
run Kiosko against the same broker. `discoveryPrefix` is Home Assistant's
(`homeassistant` unless you changed it).

## Examples

The camera page while someone is at the door, then back to normal (with a
page called "Camera" on a screen called "Desk"):

```yaml
automation:
  - alias: Doorbell on the desk panel
    triggers:
      - trigger: state
        entity_id: event.front_door_ding
    actions:
      - action: select.select_option
        target: { entity_id: select.kiosko_desk_page }
        data: { option: Camera }
      - delay: { minutes: 2 }
      - action: select.select_option
        target: { entity_id: select.kiosko_desk_page }
        data: { option: Auto }
```

The panels off when nobody is home, on when someone comes back:

```yaml
automation:
  - alias: Panels follow the house
    triggers:
      - trigger: state
        entity_id: zone.home
    actions:
      - action: "switch.turn_{{ 'on' if states('zone.home') | int > 0 else 'off' }}"
        target:
          entity_id:
            - switch.kiosko_desk_display
            - switch.kiosko_news_display
```

(The entity ids come from the device and entity names: *Kiosko Desk* +
*Page* → `select.kiosko_desk_page`. In Spanish, *Página* →
`select.kiosko_desk_pagina`. Check them in the device's page.)

## Topics

For other MQTT tools. `<node>` is `nodeId`, `<screen>` the screen's id.

| Topic | |
|---|---|
| `kiosko/<node>/status` | `online` / `offline` (retained; `offline` is also the last will). |
| `kiosko/<node>/<screen>/page` | The chosen page's name, or `Auto` (retained). |
| `kiosko/<node>/<screen>/page/set` | Send a page's name, or `Auto`. |
| `kiosko/<node>/<screen>/shown` | The page on the panel (retained). |
| `kiosko/<node>/<screen>/display` | `ON` / `OFF` (retained). |
| `kiosko/<node>/<screen>/display/set` | Send `ON` or `OFF`. |
| `kiosko/<node>/<screen>/interlude/<slot>/press` | Send anything: plays that interlude. |

The client is Kiosko's own (MQTT 3.1.1, QoS 0): no dependency, and it
reconnects by itself (a wrong password waits 5 minutes between tries, so it
doesn't flood the broker's log).

Smoke on every panel, as an alert that flashes until someone has seen it
(Kiosko's API from Home Assistant, with a `rest_command`; `X-Kiosko` is
required, and Kiosko must listen where Home Assistant can reach it):

```yaml
rest_command:
  kiosko_alert:
    url: http://kiosko-pc.local:7420/api/alerts
    method: POST
    headers: { X-Kiosko: "1" }
    content_type: application/json
    payload: '{"id":"{{ id }}","level":"{{ level }}","title":"{{ title }}","icon":"{{ icon }}"}'

automation:
  - alias: Smoke on the panels
    triggers:
      - trigger: state
        entity_id: binary_sensor.kitchen_smoke
        to: "on"
    actions:
      - action: rest_command.kiosko_alert
        data: { id: smoke-kitchen, level: critical, title: Smoke in the kitchen, icon: flame }
```
