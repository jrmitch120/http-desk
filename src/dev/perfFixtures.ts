// Dev-only fixtures for the large-response perf test (e2e/perf), generated in
// the page rather than checked in. The mock builds them when a test calls
// `__mock.preparePerf()`, before it starts measuring.

/**
 * A minified JSON body of at least `bytes` bytes (and less than one item
 * more): `{"items":[…]}`, objects with 19-digit ids, the last one named `last`
 * (a term that matches only near the end). With it, the same document
 * pretty-printed as the core's formatter writes it: two-space indent, numbers
 * as the server wrote them. At 50 MB, Pretty is about 88 MB over millions of lines.
 */
export function largeJson(bytes: number, last: string): { json: string; pretty: string } {
  // Odd and above 2^53, so a plain JSON.parse would round every one.
  const id = (base: number, i: number) => `${base}${String(i).padStart(9, "0")}987654321`;
  const min: string[] = [];
  const pretty: string[] = [];
  let size = `{"items":[]}`.length;
  for (let i = 0; size < bytes; i++) {
    const item = (name: string) => [
      `{"id":${id(1, i)},"name":"${name}","status":"sold","price":10.50,"active":true,"tags":["good","dog","cute"],"owner":{"id":${id(2, i)},"name":"Ann"}}`,
      `    {
      "id": ${id(1, i)},
      "name": "${name}",
      "status": "sold",
      "price": 10.50,
      "active": true,
      "tags": [
        "good",
        "dog",
        "cute"
      ],
      "owner": {
        "id": ${id(2, i)},
        "name": "Ann"
      }
    }`,
    ];
    let [m, p] = item(`pet-${i}`);
    size += m.length + (i > 0 ? 1 : 0);
    if (size >= bytes) [m, p] = item(last);
    min.push(m);
    pretty.push(p);
  }
  return { json: `{"items":[${min.join(",")}]}`, pretty: `{\n  "items": [\n${pretty.join(",\n")}\n  ]\n}` };
}

/** A 24-bit BMP of `width` × `height` pixels, a colour gradient. */
export function bmpImage(width: number, height: number): Uint8Array {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42; // "BM"
  bytes[1] = 0x4d;
  view.setUint32(2, size, true);
  view.setUint32(10, 54, true); // pixel data offset
  view.setUint32(14, 40, true); // BITMAPINFOHEADER
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(34, row * height, true);
  for (let y = 0; y < height; y++) {
    let o = 54 + y * row;
    for (let x = 0; x < width; x++) {
      bytes[o++] = (x * 255) / width;
      bytes[o++] = (y * 255) / height;
      bytes[o++] = 128;
    }
  }
  return bytes;
}

/** Base64 of `bytes`, in pieces so a large body doesn't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const piece = 3 * 16_384; // a multiple of 3, so pieces join without padding
  for (let i = 0; i < bytes.length; i += piece) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + piece))));
  return parts.join("");
}

/**
 * A `.http` file of `requests` requests (the large-file perf test, #168): File
 * variables at the top, then requests of the common shapes in turn (a GET with a
 * query and a disabled header, a JSON POST, a PUT with a response handler, a
 * DELETE with directives), about 8 lines each.
 */
export function largeHttpFile(requests: number): string {
  const out = ["@host = http://localhost:8765", "@token = secret-token", ""];
  for (let i = 0; i < requests; i++) {
    switch (i % 4) {
      case 0:
        out.push(`### List items ${i}`, `# Returns page ${i} of the items.`, `GET {{host}}/items?page=${i}&limit=20`, "Accept: application/json", "#~ X-Debug: true", "");
        break;
      case 1:
        out.push(`### Create item ${i}`, `POST {{host}}/items`, "Content-Type: application/json", "Authorization: Bearer {{token}}", "", "{", `  "name": "item ${i}",`, '  "tags": ["a", "b"],', `  "price": ${i}.50`, "}", "");
        break;
      case 2:
        out.push(`### Update item ${i}`, `PUT {{host}}/items/${i}`, "Content-Type: application/json", "", `{ "name": "renamed ${i}" }`, "", "> {%", '  client.global.set("last", response.body.id);', "%}", "");
        break;
      default:
        out.push(`### Delete item ${i}`, `# @name delete${i}`, "# @no-log", `DELETE {{host}}/items/${i}`, "Authorization: Bearer {{token}}", "");
    }
  }
  return out.join("\n");
}
