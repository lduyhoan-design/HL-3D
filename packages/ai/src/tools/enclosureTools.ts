// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Tool } from "../llm/types";

interface EnclosureApi {
    create(spec: unknown): string;
    edit(spec: unknown): string;
    presets(): Record<string, Record<string, string>>;
}

const api = () => (globalThis as { __chiliEnclosure?: EnclosureApi }).__chiliEnclosure;

/** Công cụ tạo hộp bo mạch in 3D (tab "Hộp mạch"): AI chọn module có sẵn, phần mềm tự xếp và khoét cổng. */
export function buildEnclosureTools(): Tool[] {
    const presets = api()?.presets();
    const list = (o?: Record<string, string>) =>
        o
            ? Object.entries(o)
                  .map(([k, v]) => `${k} = ${v}`)
                  .join("; ")
            : "";
    return [
        {
            name: "create_pcb_enclosure",
            description:
                "Create a 3D-printable enclosure (body + lid) for electronics modules, the way the 'Hộp mạch' tab does. ALWAYS prefer this over hand-modelling when the user asks for a box/case/hộp for boards or modules. The software lays the boards out, adds standoffs, M3 corner screws, a snap lip, and automatically cuts the connector openings (USB, RJ45, DB9) in the LEFT wall for modules that have them. " +
                `Board presets: ${list(presets?.["boards"])}. ` +
                `Screens under the lid: ${list(presets?.["screens"])}. Card readers under the lid: ${list(presets?.["readers"])}. ` +
                `Extra hole presets: ${list(presets?.["holes"])}. ` +
                `Board screw / thread options (argument screw): ${list(presets?.["screws"])}. 'lỗ ren'/'ren'/'cấy ren'/'đai ốc đồng'/'insert' → m3i (or m2i/m25i by size); 'đai ốc'/'ê cu' → m3n; 'trụ đồng'/'cọc đồng' → m3b; default m3. lid_insert=true when the user wants threaded inserts for the lid screws; screen_insert=true for threaded inserts in the posts that hold the screen / card reader under the lid ('màn hình bắt ren', 'cọc màn hình có ren'). ` +
                "Screens: 'oled' alone → oled; 'oled nhỏ'/'0.91' → oled091; 'lcd 16x2'/'1602' → lcd1602 (with I2C → lcd1602i2c); '20x4' → lcd2004; 'nextion N inch' → nxNN; 'màn tròn' → tft128r; 'e-ink'/'giấy điện tử' → epd*; 'led 7 đoạn' → tm1637; 'ma trận led' → max7219m. " +
                "Vietnamese wording → arguments: 'vừa vặn'/'vừa khít'/'gọn' → omit size (auto-fit); 'led 3 ly'/'led 3mm'/'led 3v nhỏ'/'led nhỏ' → hole preset led3; 'led 5 ly'/'led to' → led5; 'jack nguồn'/'jack DC'/'jắc nguồn' → dc55; 'nút nhấn'/'nút bấm' → btn12; 'công tắc' → kcd1; 'cổng mạng' → rj45; 'lỗ luồn dây' → cable. Faces: 'nắp'/'trên' → lid; 'mặt trước' → front; 'mặt sau' → back; 'bên trái' → left; 'bên phải' → right; 'bên hông'/'cạnh' without a side → right (the left wall already carries the module connectors); 'đáy' → bottom. Several holes of the same kind on one face → one entry with count and pitch (default 15 mm, centred). 'ESP32' without a model → esp32s3 if the user has used ESP32-S3 before, otherwise esp32; 'ESP8266'/'NodeMCU' → nodemcu; 'D1 mini' → wemos; 'relay N kênh' → relayN; 'cân'/'loadcell'/'HX711' → hx711; 'RS485' → rs485; 'sạc pin' → tp4056; 'pin 18650' → bat18650x1/x2; 'hạ áp' → lm2596; 'nguồn 220V' → hlkpm01. ESP32 presets already include the free space for the WiFi antenna. " +
                "For a module that is not in the list use preset 'custom' with l/w (mm), pillar (standoff height) and comp (component height) — ask the user for its size if unknown. Map common names: 'module mạng LAN'/'W5500'/'Ethernet' → w5500; 'RS232'/'MAX3232'/'cổng COM' → rs232. Units mm.",
            parameters: {
                type: "object",
                properties: {
                    boards: {
                        type: "array",
                        description: "Boards inside the box, in order. Strings are preset keys.",
                        items: {
                            anyOf: [
                                { type: "string" },
                                {
                                    type: "object",
                                    properties: {
                                        preset: { type: "string" },
                                        l: { type: "number" },
                                        w: { type: "number" },
                                        pillar: { type: "number" },
                                        comp: { type: "number" },
                                        stack: {
                                            type: "boolean",
                                            description: "Plugged on top of the previous board",
                                        },
                                    },
                                },
                            ],
                        },
                    },
                    screen: { type: "string", description: "Screen preset key under the lid, or 'none'" },
                    reader: {
                        type: "string",
                        description: "Card reader preset key under the lid, or 'none'",
                    },
                    size: {
                        type: "object",
                        description: "Optional inner size (mm). Omit to fit the boards automatically.",
                        properties: { l: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
                    },
                    wall: { type: "number", description: "Wall thickness mm (default 2.4)" },
                    screw: { type: "string", description: "Board screw / thread option key (default m3)" },
                    lid_insert: {
                        type: "boolean",
                        description: "Use M3 heat-set inserts for the 4 lid screws",
                    },
                    holes: {
                        type: "array",
                        description:
                            "Extra holes. face: lid|front|back|left|right|bottom. x: mm right of face centre seen from outside; y: on side faces height from the outer bottom, on lid/bottom offset towards the back. count/pitch for a row.",
                        items: {
                            type: "object",
                            properties: {
                                face: { type: "string" },
                                preset: { type: "string" },
                                shape: { type: "string", enum: ["circle", "rect"] },
                                x: { type: "number" },
                                y: { type: "number" },
                                w: { type: "number" },
                                h: { type: "number" },
                                count: { type: "number" },
                                pitch: { type: "number" },
                            },
                        },
                    },
                },
                required: ["boards"],
            },
            handler: async (args) => {
                const a = api();
                if (!a) return "Chức năng hộp mạch chưa sẵn sàng.";
                try {
                    return a.create(args);
                } catch (e) {
                    return `Lỗi: ${(e as Error).message ?? e}`;
                }
            },
        },
        {
            name: "edit_pcb_enclosure",
            description:
                "Change the EXISTING enclosure made by create_pcb_enclosure (the latest one, or the one containing the selection) and rebuild it in place — use this, not create_pcb_enclosure, for follow-ups like 'bỏ lỗ type C', 'thêm 2 lỗ led', 'cao lên 40mm', 'xoá lỗ jack'. remove_ports closes an automatic connector opening so the wall becomes solid again (names: USB/type C, RJ45/LAN, DB9/RS232); add_ports re-opens it. remove_holes takes 1-based indexes of the extra holes, a hole preset key, a face name, or 'all'. Never tell the user to do it by hand when this tool can do it.",
            parameters: {
                type: "object",
                properties: {
                    remove_ports: { type: "array", items: { type: "string" } },
                    add_ports: { type: "array", items: { type: "string" } },
                    add_holes: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                face: { type: "string" },
                                preset: { type: "string" },
                                shape: { type: "string", enum: ["circle", "rect"] },
                                x: { type: "number" },
                                y: { type: "number" },
                                w: { type: "number" },
                                h: { type: "number" },
                                count: { type: "number" },
                                pitch: { type: "number" },
                            },
                        },
                    },
                    remove_holes: {
                        type: "array",
                        items: { anyOf: [{ type: "number" }, { type: "string" }] },
                    },
                    size: {
                        anyOf: [
                            { type: "string", enum: ["auto"] },
                            {
                                type: "object",
                                properties: {
                                    l: { type: "number" },
                                    w: { type: "number" },
                                    h: { type: "number" },
                                },
                            },
                        ],
                    },
                    boards: {
                        type: "array",
                        description: "Replace the board list (same format as create_pcb_enclosure)",
                        items: {},
                    },
                    screen: { type: "string" },
                    reader: { type: "string" },
                    screw: { type: "string", description: "Board screw / thread option key" },
                    lid_insert: { type: "boolean" },
                    screen_insert: { type: "boolean" },
                },
            },
            handler: async (args) => {
                const a = api();
                if (!a) return "Chức năng hộp mạch chưa sẵn sàng.";
                try {
                    return a.edit(args);
                } catch (e) {
                    return `Lỗi: ${(e as Error).message ?? e}`;
                }
            },
        },
    ];
}
