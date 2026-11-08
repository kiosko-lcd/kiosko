# @loksly/trcc-client

A small, dependency-free Node.js client for the REST API of `trcc serve`, from
[thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux),
the Linux driver for Thermalright USB LCD panels (Trofeo Vision and others).

It comes with the lessons of running a dashboard on one of these panels 24/7:

- **No resending from the client.** The LY firmware drops the image after
  ~2-3 s without a frame, but `trcc serve` already resends the cached frame
  every ~150 ms. The client sends a frame only when something changes, and
  `pinFrame` is just a spaced health probe.
- **A canary for the keepalive contract.** `trcc` once changed the
  keepalive's behaviour behind an identical `200 OK`, which turned clients
  into silent busy loops. `checkKeepaliveContract` warns the first time the
  answer stops looking like the one this client was written for.
- **A hand-built multipart body.** Sending `FormData` + `Blob` through Node's
  `fetch` leaked every image (8 GB in nine days for a dashboard). `sendFrame`
  builds the body in a single `Buffer`, and sends JPEG or PNG based on the
  first bytes.
- **API tokens**, read from a file and re-read every 30 s, for a `trcc serve`
  started with `--token`.

## Install

```sh
npm install @loksly/trcc-client
```

Node.js 20 or newer (uses the built-in `fetch`). ESM only.

## Usage

```ts
import { connectPanel, detectPanel, pinFrame, sendFrame, serverAlive } from '@loksly/trcc-client';

const trcc = { url: 'http://127.0.0.1:8099', tokenFile: `${process.env.HOME}/.trcc-token`, timeoutMs: 20_000 };

if (!(await serverAlive(trcc))) throw new Error('trcc serve is not running');
const panel = await detectPanel(trcc); // { key: '0416:5408', width: 1920, height: 462 }
if (!panel) throw new Error('no panel');

await connectPanel(trcc, panel.key);
await sendFrame(trcc, panel.key, pngOrJpegBuffer); // render at panel.width × panel.height

const stop = pinFrame(trcc, panel.key, 30, (msg) => console.warn(msg));
// … later
stop();
```

### Options

| Field | Meaning |
|---|---|
| `url` | Base URL of `trcc serve`. |
| `token` / `tokenFile` | API token, inline or from a file. Without either, no header is sent. |
| `timeoutMs` | Per-request timeout. |
| `deviceKey` | `VID:PID` of the panel to use; empty takes the first one listed. |

## Known limits

Two identical panels share a `VID:PID`, and `trcc serve` cannot yet be told to
leave one of them alone
([trcc#317](https://github.com/Lexonight1/thermalright-trcc-linux/issues/317)).

## Contributing

This package lives in the [aimonitor](https://github.com/Loksly/aimonitor)
repository under `packages/trcc-client`. Issues and pull requests are welcome
there. Run `npm test` from the package directory.

## License

MIT
