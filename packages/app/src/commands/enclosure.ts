// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Tab "Hộp mạch": tạo hộp in 3D (thân + nắp) cho một hoặc nhiều bo mạch, màn hình, đầu đọc thẻ.
// Kích thước linh kiện là số tham khảo (mm); người dùng sửa được từng ô trong hộp thoại.

import {
    command,
    download,
    EditableShapeNode,
    FolderNode,
    type FolderNodeOptions,
    type IApplication,
    type ICommand,
    type IDocument,
    type IEventHandler,
    type INode,
    type IShape,
    type IView,
    Material,
    Matrix4,
    Plane,
    PubSub,
    Result,
    ShapeNode,
    serializable,
    serialize,
    Transaction,
    XYZ,
    type XYZLike,
} from "@chili3d/core";
import { saveToProjectFolder } from "./projectFiles";

/** Một lỗ cắt của cổng trên thành hộp; dx: lệch ngang so với tâm cổng. */
type PortCut = { shape: "rect" | "circle"; w: number; h: number; dx?: number };
/** Cổng ở đầu bo (đầu quay ra thành trái của hộp). offset: lệch theo chiều rộng bo; z: tâm cổng trên mặt bo. */
type Port = {
    name: string;
    offset: number;
    z: number;
    overhang: number;
    cuts: PortCut[];
    body?: [number, number, number];
};
/** Kiểu chân bắt bo: cọc vít ở 4 góc, 2 cọc chéo, 2 cọc ở đầu không có cổng, chốt kẹp góc, hoặc không có. */
export type MountKind = "corner4" | "diag2" | "back2" | "uno" | "list" | "clips" | "none";
type BoardPreset = {
    name: string;
    l: number;
    w: number;
    pillar: number;
    comp: number;
    ports?: Port[];
    mount?: MountKind;
    inset?: number;
    /** Phần anten WiFi thò ra / cần để trống ở đầu bo phía không có cổng (mm). */
    tail?: number;
    /** Lỗ bắt vít chuẩn của bo (mm, tính từ góc đầu-cổng, mép dưới) — dùng khi mount = "list". */
    holes?: [number, number][];
    /** Nhóm để xếp trong bảng chọn module. */
    group?: string;
};

export const MOUNT_NAMES: [MountKind, string][] = [
    ["corner4", "4 cọc vít ở góc"],
    ["diag2", "2 cọc vít chéo"],
    ["back2", "2 cọc vít đầu sau"],
    ["list", "Lỗ chuẩn của bo"],
    ["uno", "Lỗ Arduino Uno"],
    ["clips", "Chốt kẹp góc (bo không lỗ)"],
    ["none", "Không (dán keo)"],
];

/**
 * Cách bắt vít bo mạch vào cọc:
 * - tap: vít tự ren bắt thẳng vào lỗ mồi trong cọc nhựa.
 * - insert: đai ốc đồng cấy nhiệt (heat-set insert) — dùng mỏ hàn ấn vào lỗ, có ren thật, tháo lắp nhiều lần.
 * - nut: đai ốc lục giác giấu dưới đáy hộp, vít xuyên từ trên bo xuống.
 * - brass: trụ đồng lục giác (cọc đồng) bắt bằng vít từ dưới đáy lên.
 */
export type ScrewKind = "tap" | "insert" | "nut" | "brass";
export interface ScrewSpec {
    name: string;
    kind: ScrewKind;
    /** Đường kính lỗ (mm): lỗ mồi / lỗ cấy / lỗ xuyên. */
    d: number;
    /** Bán kính cọc nhựa (mm). */
    boss?: number;
    /** Sâu lỗ cấy (mm). */
    depth?: number;
    /** Đai ốc: cạnh đối cạnh và dày hốc (mm). */
    af?: number;
    nh?: number;
    /** Trụ đồng: lỗ khoét chìm đầu vít dưới đáy (đường kính, sâu). */
    cb?: [number, number];
}
export const SCREW_PILOT: Record<string, ScrewSpec> = {
    m2: { name: "M2 vít tự ren (lỗ mồi Ø1.7)", kind: "tap", d: 1.7 },
    m25: { name: "M2.5 vít tự ren (lỗ mồi Ø2.1)", kind: "tap", d: 2.1 },
    m3: { name: "M3 vít tự ren (lỗ mồi Ø2.5)", kind: "tap", d: 2.5 },
    m2i: { name: "M2 đai ốc cấy nhiệt (lỗ Ø3.2, sâu 4)", kind: "insert", d: 3.2, depth: 4, boss: 3.1 },
    m25i: { name: "M2.5 đai ốc cấy nhiệt (lỗ Ø3.6, sâu 5)", kind: "insert", d: 3.6, depth: 5, boss: 3.4 },
    m3i: { name: "M3 đai ốc cấy nhiệt (lỗ Ø4.0, sâu 5.5)", kind: "insert", d: 4.0, depth: 5.5, boss: 3.7 },
    m25n: { name: "M2.5 đai ốc lục giác giấu dưới đáy", kind: "nut", d: 2.9, af: 5.3, nh: 2.2, boss: 3.1 },
    m3n: { name: "M3 đai ốc lục giác giấu dưới đáy", kind: "nut", d: 3.4, af: 5.9, nh: 2.6, boss: 3.3 },
    m25b: { name: "M2.5 trụ đồng (dài = Cọc đỡ), vít từ dưới đáy", kind: "brass", d: 2.9, cb: [5, 1.4] },
    m3b: { name: "M3 trụ đồng (dài = Cọc đỡ), vít từ dưới đáy", kind: "brass", d: 3.4, cb: [6, 1.6] },
};
const screwOf = (o: EnclosureOptions): ScrewSpec => SCREW_PILOT[o.screw ?? "m3"] ?? SCREW_PILOT["m3"]!;

const usbPort = (w: number, h: number, overhang = 1): Port[] => [
    { name: "USB", offset: 0, z: 1.6, overhang, cuts: [{ shape: "rect", w, h }] },
];

const MCU = "Vi điều khiển";
const COMM = "Truyền thông";
const POWER = "Nguồn";
const DRIVE = "Relay / Driver";
const OTHER = "Khác";

const rj45: Port = {
    name: "RJ45",
    offset: 0,
    z: 6.9,
    overhang: 2,
    cuts: [{ shape: "rect", w: 16.6, h: 14 }],
    body: [21.3, 16, 13.5],
};

export const BOARD_PRESETS: Record<string, BoardPreset> = {
    // ---- vi điều khiển (đầu có cổng USB quay ra thành trái; anten WiFi ở đầu kia, để trống)
    esp32: {
        group: MCU,
        name: "ESP32 DevKit V1 (30 chân)",
        l: 51.8,
        w: 28.2,
        pillar: 9,
        comp: 6,
        ports: usbPort(12, 7),
        mount: "clips",
        tail: 7,
    },
    esp32_38: {
        group: MCU,
        name: "ESP32 DevKitC (38 chân)",
        l: 55,
        w: 28,
        pillar: 9,
        comp: 6,
        ports: usbPort(12, 7),
        mount: "clips",
        tail: 7,
    },
    esp32s3: {
        group: MCU,
        name: "ESP32-S3 DevKitC-1",
        l: 63,
        w: 26,
        pillar: 9,
        comp: 6,
        ports: usbPort(24, 8),
        mount: "clips",
        tail: 7,
    },
    esp32s3mini: {
        group: MCU,
        name: "ESP32-S3 Super Mini",
        l: 23,
        w: 18,
        pillar: 3,
        comp: 3,
        ports: usbPort(11, 5.5),
        mount: "clips",
        tail: 4,
    },
    esp32c3mini: {
        group: MCU,
        name: "ESP32-C3 Super Mini",
        l: 22.5,
        w: 18,
        pillar: 3,
        comp: 3,
        ports: usbPort(11, 5.5),
        mount: "clips",
        tail: 4,
    },
    esp32cam: { group: MCU, name: "ESP32-CAM", l: 40, w: 27, pillar: 9, comp: 10, mount: "clips", tail: 4 },
    nodemcu: {
        group: MCU,
        name: "NodeMCU ESP8266 V3 (CH340)",
        l: 58,
        w: 31,
        pillar: 9,
        comp: 6,
        ports: usbPort(12, 7),
        mount: "corner4",
        inset: 2.5,
        tail: 5,
    },
    wemos: {
        group: MCU,
        name: "Wemos D1 mini ESP8266",
        l: 34.2,
        w: 25.6,
        pillar: 4,
        comp: 5,
        ports: usbPort(10, 6),
        mount: "clips",
        tail: 4,
    },
    uno: {
        group: MCU,
        name: "Arduino Uno R3",
        l: 68.6,
        w: 53.4,
        pillar: 4,
        comp: 12,
        ports: [
            { name: "USB", offset: 11.4, z: 5.5, overhang: 6, cuts: [{ shape: "rect", w: 13, h: 12 }] },
            { name: "Jack DC", offset: -19, z: 5.5, overhang: 2, cuts: [{ shape: "rect", w: 10, h: 11.5 }] },
        ],
        mount: "list",
        holes: [
            [13.97, 2.54],
            [15.24, 50.8],
            [66.04, 7.62],
            [66.04, 35.56],
        ],
    },
    mega: {
        group: MCU,
        name: "Arduino Mega 2560",
        l: 101.6,
        w: 53.3,
        pillar: 4,
        comp: 12,
        ports: [
            { name: "USB", offset: 11.4, z: 5.5, overhang: 6, cuts: [{ shape: "rect", w: 13, h: 12 }] },
            { name: "Jack DC", offset: -19, z: 5.5, overhang: 2, cuts: [{ shape: "rect", w: 10, h: 11.5 }] },
        ],
        mount: "list",
        holes: [
            [13.97, 2.54],
            [15.24, 50.8],
            [66.04, 7.62],
            [66.04, 35.56],
            [90.17, 50.8],
            [96.52, 2.54],
        ],
    },
    nano: {
        group: MCU,
        name: "Arduino Nano",
        l: 43.2,
        w: 18,
        pillar: 9,
        comp: 4,
        ports: usbPort(9, 5),
        mount: "clips",
    },
    pico: {
        group: MCU,
        name: "Raspberry Pi Pico",
        l: 51,
        w: 21,
        pillar: 4,
        comp: 3,
        ports: usbPort(9, 5, 1.3),
        mount: "list",
        holes: [
            [2, 4.8],
            [2, 16.2],
            [49, 4.8],
            [49, 16.2],
        ],
    },
    // ---- truyền thông
    w5500: {
        group: COMM,
        name: "Module mạng LAN W5500 (cổng RJ45)",
        l: 55,
        w: 28,
        pillar: 4,
        comp: 14,
        ports: [rj45],
        mount: "corner4",
        inset: 2.5,
    },
    enc28j60: {
        group: COMM,
        name: "Module mạng LAN ENC28J60 (cổng RJ45)",
        l: 57,
        w: 34,
        pillar: 4,
        comp: 14,
        ports: [rj45],
        mount: "corner4",
        inset: 2.5,
    },
    rs232: {
        group: COMM,
        name: "Module RS232-TTL MAX3232 (cổng DB9)",
        l: 39,
        w: 32,
        pillar: 4,
        comp: 13,
        ports: [
            {
                name: "DB9",
                offset: 0,
                z: 6.3,
                overhang: 0,
                // lỗ hình chữ D + 2 lỗ cho cọc vít lục giác cách nhau 25 mm
                cuts: [
                    { shape: "rect", w: 20, h: 11.5 },
                    { shape: "circle", w: 5.6, h: 5.6, dx: -12.5 },
                    { shape: "circle", w: 5.6, h: 5.6, dx: 12.5 },
                ],
                body: [10, 30.8, 12.5],
            },
        ],
        mount: "back2",
        inset: 3,
    },
    rs485: { group: COMM, name: "Module RS485 MAX485", l: 44, w: 14, pillar: 4, comp: 8, mount: "clips" },
    sim800l: { group: COMM, name: "Module SIM800L (GSM)", l: 25, w: 23, pillar: 4, comp: 6, mount: "clips" },
    lora: {
        group: COMM,
        name: "Module LoRa E32 (cổng ăng-ten SMA)",
        l: 36,
        w: 21,
        pillar: 4,
        comp: 6,
        ports: [{ name: "SMA", offset: 0, z: 3, overhang: 8, cuts: [{ shape: "circle", w: 6.6, h: 6.6 }] }],
        mount: "clips",
    },
    sdcard: {
        group: COMM,
        name: "Module thẻ nhớ microSD",
        l: 42,
        w: 24,
        pillar: 4,
        comp: 4,
        ports: [{ name: "Khe thẻ SD", offset: 0, z: 1, overhang: 0, cuts: [{ shape: "rect", w: 14, h: 3 }] }],
        mount: "corner4",
        inset: 2.2,
    },
    // ---- nguồn
    lm2596: {
        group: POWER,
        name: "Mạch hạ áp LM2596",
        l: 43,
        w: 21,
        pillar: 4,
        comp: 14,
        mount: "diag2",
        inset: 3,
    },
    xl4015: {
        group: POWER,
        name: "Mạch hạ áp XL4015 5A",
        l: 54,
        w: 26,
        pillar: 4,
        comp: 14,
        mount: "corner4",
        inset: 3,
    },
    mp1584: { group: POWER, name: "Hạ áp mini MP1584", l: 22, w: 17, pillar: 3, comp: 4, mount: "clips" },
    tp4056: {
        group: POWER,
        name: "Mạch sạc pin TP4056 (Type-C)",
        l: 26,
        w: 17,
        pillar: 3,
        comp: 3,
        ports: usbPort(9.5, 3.8),
        mount: "clips",
    },
    hlk: {
        group: POWER,
        name: "Nguồn HLK-5M05 (220V→5V)",
        l: 38,
        w: 23,
        pillar: 0,
        comp: 18,
        mount: "clips",
    },
    hlkpm01: {
        group: POWER,
        name: "Nguồn HLK-PM01 (220V→5V)",
        l: 34,
        w: 20,
        pillar: 0,
        comp: 15,
        mount: "clips",
    },
    bat18650x1: { group: POWER, name: "Đế pin 18650 × 1", l: 77, w: 21, pillar: 0, comp: 19, mount: "none" },
    bat18650x2: { group: POWER, name: "Đế pin 18650 × 2", l: 77, w: 41, pillar: 0, comp: 19, mount: "none" },
    // ---- relay, driver
    relay1: {
        group: DRIVE,
        name: "Module relay 1 kênh",
        l: 50,
        w: 26,
        pillar: 4,
        comp: 19,
        mount: "corner4",
        inset: 2.5,
    },
    relay2: {
        group: DRIVE,
        name: "Module relay 2 kênh",
        l: 50,
        w: 38,
        pillar: 4,
        comp: 19,
        mount: "corner4",
        inset: 2.5,
    },
    relay4: {
        group: DRIVE,
        name: "Module relay 4 kênh",
        l: 75,
        w: 55,
        pillar: 4,
        comp: 19,
        mount: "corner4",
        inset: 3,
    },
    relay8: {
        group: DRIVE,
        name: "Module relay 8 kênh",
        l: 138,
        w: 56,
        pillar: 4,
        comp: 19,
        mount: "corner4",
        inset: 3,
    },
    l298n: {
        group: DRIVE,
        name: "Driver động cơ L298N",
        l: 43,
        w: 43,
        pillar: 4,
        comp: 27,
        mount: "corner4",
        inset: 2.5,
    },
    mosfet: {
        group: DRIVE,
        name: "Module MOSFET IRF520",
        l: 33,
        w: 24,
        pillar: 4,
        comp: 9,
        mount: "diag2",
        inset: 2.5,
    },
    // ---- khác
    hx711: { group: OTHER, name: "Module cân HX711", l: 34, w: 21, pillar: 4, comp: 4, mount: "clips" },
    ds3231: {
        group: OTHER,
        name: "Đồng hồ thời gian thực DS3231",
        l: 38,
        w: 22,
        pillar: 4,
        comp: 9,
        mount: "clips",
    },
    buzzer: { group: OTHER, name: "Module còi buzzer", l: 33, w: 13, pillar: 3, comp: 10, mount: "clips" },
    custom: {
        group: OTHER,
        name: "Bo khác (tự nhập)",
        l: 50,
        w: 30,
        pillar: 5,
        comp: 10,
        mount: "corner4",
        inset: 3,
    },
};

/** Bo có cổng cần quay ra thành hộp. */
const allPortsOf = (b: BoardRow): Port[] =>
    b.preset === "custom" ? [] : (BOARD_PRESETS[b.preset]?.ports ?? []);
const portsOf = (b: BoardRow): Port[] => allPortsOf(b).filter((p) => !b.portsOff?.includes(p.name));
const portOverhang = (b: BoardRow) => Math.max(0, ...portsOf(b).map((p) => p.overhang));

/** Chiều dài bo cần chỗ (mạch + vùng anten ở đầu kia). */
const tailOf = (b: BoardRow): number => (b.preset === "custom" ? 0 : (BOARD_PRESETS[b.preset]?.tail ?? 0));
const lenOf = (b: BoardRow): number => b.l + tailOf(b);

const mountOf = (b: BoardRow): MountKind => b.mount ?? BOARD_PRESETS[b.preset]?.mount ?? "corner4";
const insetOf = (b: BoardRow): number => b.inset ?? BOARD_PRESETS[b.preset]?.inset ?? 3;

/** Vị trí lỗ bắt vít trên bo (mm, tính từ góc đầu-trái của bo; đầu trái là đầu có cổng). */
function mountHoles(b: BoardRow): [number, number][] {
    const i = insetOf(b);
    const { l, w } = b;
    switch (mountOf(b)) {
        case "corner4":
            return [
                [i, i],
                [l - i, i],
                [i, w - i],
                [l - i, w - i],
            ];
        case "diag2":
            return [
                [i, i],
                [l - i, w - i],
            ];
        case "back2":
            return [
                [l - i, i],
                [l - i, w - i],
            ];
        case "list":
            return BOARD_PRESETS[b.preset]?.holes ?? [];
        case "uno":
            // lỗ chuẩn Arduino Uno R3 (đầu cổng USB ở bên trái)
            return [
                [13.97, 2.54],
                [15.24, 50.8],
                [66.04, 7.62],
                [66.04, 35.56],
            ];
        default:
            return [];
    }
}

/**
 * Màn hình gắn dưới nắp. w × h: kích thước bo; win: ô khoét lộ màn (dài × rộng, lệch wdx theo chiều dài);
 * holes: khoảng cách 4 lỗ bắt vít (null = bo không có lỗ, làm 4 gờ chặn góc rồi dán keo);
 * hr: bán kính lỗ; so: dày phần kính / màn nhô trên mặt bo; th: cao linh kiện, chân cắm dưới bo.
 * Số đo là số tham khảo theo loại phổ biến trên thị trường, nên đo lại bo thật trước khi in bản chính.
 */
type ScreenPreset = {
    name: string;
    group?: string;
    w: number;
    h: number;
    win: [number, number];
    wdx?: number;
    round?: boolean;
    holes: [number, number] | null;
    hr: number;
    so: number;
    th: number;
};
const OLED = "OLED";
const LCD = "LCD ký tự / đồ hoạ";
const TFT = "TFT màu";
const HMI = "Màn cảm ứng HMI (Nextion)";
const EPD = "Giấy điện tử (E-paper)";
const LED = "LED 7 đoạn / ma trận";
export const SCREEN_PRESETS: Record<string, ScreenPreset | null> = {
    none: null,
    // ---- OLED
    oled091: {
        group: OLED,
        name: 'OLED 0.91" 128×32 SSD1306',
        w: 38,
        h: 12,
        win: [23, 6],
        wdx: -2,
        holes: null,
        hr: 1,
        so: 1.5,
        th: 3,
    },
    oled: {
        group: OLED,
        name: 'OLED 0.96" SSD1306',
        w: 27.3,
        h: 27.8,
        win: [22.5, 11.5],
        holes: [23.4, 23.8],
        hr: 1,
        so: 1.5,
        th: 4,
    },
    oled13: {
        group: OLED,
        name: 'OLED 1.3" SH1106',
        w: 35.4,
        h: 33.5,
        win: [30, 16],
        holes: [30.4, 28.5],
        hr: 1.1,
        so: 1.5,
        th: 4,
    },
    oled154: {
        group: OLED,
        name: 'OLED 1.54" SSD1309',
        w: 44.5,
        h: 37,
        win: [36, 19],
        holes: [39.5, 32],
        hr: 1.1,
        so: 1.8,
        th: 4,
    },
    oled242: {
        group: OLED,
        name: 'OLED 2.42" SSD1309',
        w: 70.5,
        h: 42.5,
        win: [58, 30],
        holes: [65, 37.5],
        hr: 1.5,
        so: 2,
        th: 4,
    },
    // ---- LCD
    lcd1602: {
        group: LCD,
        name: "LCD 1602",
        w: 80,
        h: 36,
        win: [65, 15],
        holes: [75, 31],
        hr: 1.5,
        so: 7,
        th: 14,
    },
    lcd1602i2c: {
        group: LCD,
        name: "LCD 1602 + mạch I2C",
        w: 80,
        h: 36,
        win: [65, 15],
        holes: [75, 31],
        hr: 1.5,
        so: 7,
        th: 20,
    },
    lcd2004: {
        group: LCD,
        name: "LCD 2004",
        w: 98,
        h: 60,
        win: [77, 26],
        holes: [93, 55],
        hr: 1.5,
        so: 9.5,
        th: 14,
    },
    lcd2004i2c: {
        group: LCD,
        name: "LCD 2004 + mạch I2C",
        w: 98,
        h: 60,
        win: [77, 26],
        holes: [93, 55],
        hr: 1.5,
        so: 9.5,
        th: 20,
    },
    lcd12864: {
        group: LCD,
        name: "LCD 12864 ST7920",
        w: 93,
        h: 70,
        win: [72, 40],
        holes: [88, 65],
        hr: 1.5,
        so: 9,
        th: 14,
    },
    nokia5110: {
        group: LCD,
        name: "LCD Nokia 5110",
        w: 45,
        h: 45,
        win: [36, 26],
        wdx: 0,
        holes: [40, 40],
        hr: 1.3,
        so: 5,
        th: 4,
    },
    // ---- TFT
    tft096: {
        group: TFT,
        name: 'TFT 0.96" ST7735 (80×160)',
        w: 30,
        h: 24,
        win: [22, 11.5],
        wdx: 1,
        holes: null,
        hr: 1,
        so: 2,
        th: 3,
    },
    tft114: {
        group: TFT,
        name: 'TFT 1.14" ST7789 (135×240)',
        w: 31,
        h: 18,
        win: [25, 15],
        wdx: 1,
        holes: null,
        hr: 1,
        so: 2,
        th: 3,
    },
    tft128r: {
        group: TFT,
        name: 'TFT tròn 1.28" GC9A01',
        w: 37,
        h: 37,
        win: [33, 33],
        round: true,
        holes: null,
        hr: 1,
        so: 2.5,
        th: 3,
    },
    tft144: {
        group: TFT,
        name: 'TFT 1.44" ST7735 (128×128)',
        w: 38.5,
        h: 32.5,
        win: [27, 27],
        wdx: 3,
        holes: [33, 28],
        hr: 1.4,
        so: 2.5,
        th: 4,
    },
    tft154: {
        group: TFT,
        name: 'TFT 1.54" ST7789 (240×240)',
        w: 45,
        h: 32,
        win: [28, 28],
        wdx: 3,
        holes: [40, 27],
        hr: 1.4,
        so: 2.5,
        th: 4,
    },
    tft18: {
        group: TFT,
        name: 'TFT 1.8" ST7735 (128×160)',
        w: 58,
        h: 34.5,
        win: [36, 28.5],
        wdx: 4,
        holes: [52, 29],
        hr: 1.5,
        so: 3,
        th: 5,
    },
    tft20: {
        group: TFT,
        name: 'TFT 2.0" ST7789 (240×320)',
        w: 60,
        h: 37,
        win: [41, 31],
        wdx: 3,
        holes: [54, 31],
        hr: 1.5,
        so: 3,
        th: 5,
    },
    tft24: {
        group: TFT,
        name: 'TFT 2.4" SPI ILI9341',
        w: 72,
        h: 43,
        win: [50, 37.5],
        holes: [66, 37],
        hr: 1.5,
        so: 3.5,
        th: 6,
    },
    tft28: {
        group: TFT,
        name: 'TFT 2.8" SPI ILI9341 (cảm ứng)',
        w: 86,
        h: 50,
        win: [58.5, 44],
        wdx: 3,
        holes: [80, 44],
        hr: 1.6,
        so: 4,
        th: 6,
    },
    cyd28: {
        group: TFT,
        name: 'ESP32 + màn 2.8" (CYD ESP32-2432S028)',
        w: 86,
        h: 50,
        win: [58.5, 44],
        wdx: 3,
        holes: [80, 44],
        hr: 1.6,
        so: 4,
        th: 10,
    },
    // theo bản vẽ lcdwiki MSP3218: bo 89.3 × 55.04, lỗ Ø3.2 cách mép 3 mm, vùng hiển thị 64.8 × 48.6, kính dày 2.9
    tft32: {
        group: TFT,
        name: 'TFT 3.2" SPI ILI9341 (14 chân)',
        w: 89.3,
        h: 55.04,
        win: [65.8, 49.6],
        wdx: 2.85,
        holes: [83.3, 49.04],
        hr: 1.6,
        so: 3,
        th: 9,
    },
    tft35: {
        group: TFT,
        name: 'TFT 3.5" SPI ILI9488',
        w: 98,
        h: 56,
        win: [74, 50],
        holes: [92, 50],
        hr: 1.5,
        so: 3.5,
        th: 6,
    },
    tft40: {
        group: TFT,
        name: 'TFT 4.0" SPI ST7796',
        w: 108,
        h: 62,
        win: [85, 57],
        wdx: 2,
        holes: [102, 56],
        hr: 1.6,
        so: 4,
        th: 6,
    },
    // ---- HMI Nextion
    nx24: {
        group: HMI,
        name: 'Nextion 2.4" NX3224',
        w: 74.4,
        h: 42.9,
        win: [50, 37.5],
        wdx: 4,
        holes: [69, 38],
        hr: 1.6,
        so: 4,
        th: 8,
    },
    nx28: {
        group: HMI,
        name: 'Nextion 2.8" NX3224T028',
        w: 85,
        h: 50,
        win: [58, 44],
        wdx: 4,
        holes: [80, 45],
        hr: 1.6,
        so: 4,
        th: 8,
    },
    nx32: {
        group: HMI,
        name: 'Nextion 3.2" NX4024T032',
        w: 95,
        h: 57,
        win: [66, 50],
        wdx: 4,
        holes: [89, 51],
        hr: 1.6,
        so: 4.5,
        th: 8,
    },
    nx35: {
        group: HMI,
        name: 'Nextion 3.5" NX4832T035',
        w: 100.5,
        h: 55,
        win: [74, 49.5],
        wdx: 4,
        holes: [94.5, 49],
        hr: 1.6,
        so: 4.5,
        th: 8,
    },
    nx43: {
        group: HMI,
        name: 'Nextion 4.3" NX4827T043',
        w: 120,
        h: 74,
        win: [96, 54.5],
        wdx: 4,
        holes: [113, 66],
        hr: 1.6,
        so: 5,
        th: 8,
    },
    nx50: {
        group: HMI,
        name: 'Nextion 5.0" NX8048T050',
        w: 133,
        h: 84,
        win: [109, 65.5],
        wdx: 3,
        holes: [126, 76],
        hr: 1.6,
        so: 5,
        th: 8,
    },
    nx70: {
        group: HMI,
        name: 'Nextion 7.0" NX8048T070',
        w: 181,
        h: 108,
        win: [155, 87],
        wdx: 3,
        holes: [173, 100],
        hr: 1.6,
        so: 5,
        th: 8,
    },
    // ---- E-paper
    epd154: {
        group: EPD,
        name: 'E-paper 1.54" (200×200)',
        w: 48,
        h: 33,
        win: [28, 28],
        wdx: 4,
        holes: [41, 26],
        hr: 1.5,
        so: 1.5,
        th: 4,
    },
    epd213: {
        group: EPD,
        name: 'E-paper 2.13" (250×122)',
        w: 65,
        h: 30.2,
        win: [49, 24],
        wdx: 2,
        holes: [58, 23],
        hr: 1.5,
        so: 1.5,
        th: 4,
    },
    epd29: {
        group: EPD,
        name: 'E-paper 2.9" (296×128)',
        w: 89.5,
        h: 38,
        win: [67.5, 29.5],
        wdx: 3,
        holes: [82.5, 31],
        hr: 1.5,
        so: 1.5,
        th: 4,
    },
    epd42: {
        group: EPD,
        name: 'E-paper 4.2" (400×300)',
        w: 103,
        h: 78.5,
        win: [85, 64],
        wdx: 1,
        holes: [96, 71.5],
        hr: 1.5,
        so: 1.5,
        th: 4,
    },
    // ---- LED
    tm1637: {
        group: LED,
        name: 'LED 7 đoạn 4 số TM1637 (0.36")',
        w: 42,
        h: 24,
        win: [30.5, 14.5],
        wdx: -2,
        holes: [37, 19],
        hr: 1.1,
        so: 7.5,
        th: 3,
    },
    tm1637l: {
        group: LED,
        name: 'LED 7 đoạn 4 số TM1637 (0.56")',
        w: 50.5,
        h: 19,
        win: [50.5 - 1, 19 - 1],
        holes: null,
        hr: 1,
        so: 8,
        th: 3,
    },
    max7219d8: {
        group: LED,
        name: "LED 7 đoạn 8 số MAX7219",
        w: 82,
        h: 15,
        win: [76, 13.5],
        holes: null,
        hr: 1,
        so: 7,
        th: 4,
    },
    max7219m: {
        group: LED,
        name: "LED ma trận 8×8 MAX7219",
        w: 32.5,
        h: 32.5,
        win: [31.5, 31.5],
        holes: null,
        hr: 1,
        so: 9,
        th: 6,
    },
    max7219m4: {
        group: LED,
        name: "LED ma trận 4 khối 32×8 MAX7219 (FC-16)",
        w: 128,
        h: 32.5,
        win: [127, 31.5],
        holes: null,
        hr: 1,
        so: 9,
        th: 6,
    },
};

type ReaderPreset = {
    name: string;
    w: number;
    h: number;
    holes: [number, number];
    hr: number;
    so: number;
    th: number;
};
export const READER_PRESETS: Record<string, ReaderPreset | null> = {
    none: null,
    rc522: { name: "RC522 RFID 13.56 MHz", w: 60, h: 39, holes: [53, 32], hr: 1.5, so: 2, th: 3 },
    pn532: { name: "PN532 NFC", w: 42.7, h: 40.4, holes: [36, 34], hr: 1.5, so: 2, th: 4 },
};

export interface BoardRow {
    preset: string;
    l: number;
    w: number;
    pillar: number;
    comp: number;
    stack: boolean;
    mount?: MountKind;
    inset?: number;
    /** Tên các cổng không khoét (ví dụ ["USB"]). */
    portsOff?: string[];
}

export interface EnclosureOptions {
    boards: BoardRow[];
    screen: string;
    reader: string;
    wall: number;
    clear: number;
    gap: number;
    manual: boolean;
    manL: number;
    manW: number;
    manH: number;
    screws: boolean;
    usb: boolean;
    vents: boolean;
    parts: boolean;
    screw?: string;
    /** 4 vít nắp dùng đai ốc cấy nhiệt M3 thay cho vít tự ren. */
    lidInsert?: boolean;
    /** Cọc bắt màn hình / đầu đọc thẻ dưới nắp dùng đai ốc cấy nhiệt (có ren). */
    screenInsert?: boolean;
}

export const DEFAULT_ENCLOSURE: EnclosureOptions = {
    boards: [
        { preset: "esp32s3", l: 69, w: 26, pillar: 9, comp: 6, stack: false },
        { preset: "relay1", l: 50, w: 26, pillar: 4, comp: 19, stack: false },
    ],
    screen: "oled",
    reader: "rc522",
    wall: 2.4,
    clear: 3,
    gap: 4,
    manual: false,
    manL: 120,
    manW: 80,
    manH: 35,
    screws: true,
    usb: true,
    vents: true,
    parts: true,
};

interface Placed {
    row: BoardRow;
    preset: BoardPreset;
    x: number; // tâm theo X
    y: number; // tâm theo Y
    z: number; // mặt dưới PCB (tính từ mặt trong đáy)
    edge: boolean; // nằm sát thành trái (-X)
}

export interface EnclosureLayout {
    L: number;
    W: number;
    H: number;
    hMin: number;
    needL: number;
    needW: number;
    placed: Placed[];
    zone: number;
    lidL: number;
    sx: number;
    rx: number;
}

/** Xếp các bo theo hàng (bo đánh dấu "chồng" thì nằm trên bo ngay trước nó). */
export function layoutEnclosure(o: EnclosureOptions): EnclosureLayout {
    const zone = o.screws ? 7.5 : 0;
    const columns: { base: BoardRow; stack: BoardRow[] }[] = [];
    for (const b of o.boards) {
        if (b.stack && columns.length) columns[columns.length - 1].stack.push(b);
        else columns.push({ base: b, stack: [] });
    }
    const colHeight = (c: { base: BoardRow; stack: BoardRow[] }) =>
        [c.base, ...c.stack].reduce((s, b) => s + b.pillar + 1.6 + b.comp, 0);

    // xếp hàng: mỗi hàng dài tối đa "target", rộng bằng bo rộng nhất trong hàng
    const area = columns.reduce((s, c) => s + (lenOf(c.base) + o.gap) * (c.base.w + o.gap), 0);
    const maxL = Math.max(10, ...columns.map((c) => lenOf(c.base)));
    const target = Math.max(maxL, Math.sqrt(area * 1.6));
    // Bo có cổng (USB, RJ45, DB9...) mỗi bo mở đầu một hàng, sát thành trái để cổng quay ra ngoài.
    // Các bo còn lại xếp nối vào hàng ngắn nhất, hàng nào đầy thì mở hàng mới.
    type Row = { cols: typeof columns; len: number; wid: number; port: number };
    const rows: Row[] = [];
    const usePorts = o.usb;
    const portCols = usePorts ? columns.filter((c) => portsOf(c.base).length) : [];
    const otherCols = columns.filter((c) => !portCols.includes(c));
    for (const c of portCols) {
        const ov = portOverhang(c.base);
        rows.push({ cols: [c], len: lenOf(c.base), wid: c.base.w, port: ov + 0.5 });
    }
    const rowLimit = Math.max(target, ...rows.map((r) => r.len + r.port));
    for (const c of otherCols) {
        const fit = rows
            .filter(
                (r) => r.port + r.len + o.gap + lenOf(c.base) <= rowLimit + 0.01 && c.base.w <= r.wid + 0.01,
            )
            .sort((a, b) => a.len - b.len)[0];
        let r = fit;
        if (!r) {
            const last = rows[rows.length - 1];
            if (last && !last.port && last.len + o.gap + lenOf(c.base) <= rowLimit + 0.01) r = last;
        }
        if (!r) {
            r = { cols: [], len: -o.gap, wid: 0, port: 0 };
            rows.push(r);
        }
        r.cols.push(c);
        r.len += o.gap + lenOf(c.base);
        r.wid = Math.max(r.wid, c.base.w);
    }
    const boardsL = Math.max(0, ...rows.map((r) => r.len + (r.port ? r.port - o.clear : 0)));
    const boardsW = rows.reduce((s, r) => s + r.wid, 0) + Math.max(0, rows.length - 1) * o.gap;

    const sc = SCREEN_PRESETS[o.screen] ?? null;
    const rd = READER_PRESETS[o.reader] ?? null;
    const lidGap = sc && rd ? 8 : 0;
    const lidL = (sc?.w ?? 0) + lidGap + (rd?.w ?? 0);
    const lidW = Math.max(sc?.h ?? 0, rd?.h ?? 0);
    const lidStack = Math.max(sc ? sc.so + sc.th : 0, rd ? rd.so + rd.th : 0);

    const needL = round(Math.max(boardsL + 2 * o.clear, lidL + 2 * o.clear, 30));
    const needW = round(Math.max(boardsW + 2 * o.clear + 2 * zone, lidW + 2 * o.clear + 2 * zone, 30));
    const hMin = Math.ceil(Math.max(0, ...columns.map(colHeight)) + lidStack + 3);
    const L = o.manual ? Math.max(10, o.manL) : needL;
    const W = o.manual ? Math.max(10, o.manW) : needW;
    const H = o.manual ? Math.max(8, o.manH) : Math.max(hMin, 20);

    const placed: Placed[] = [];
    let y = W / 2 - zone - o.clear;
    for (const r of rows) {
        let x = -L / 2 + (r.port ? r.port : o.clear);
        r.cols.forEach((c, i) => {
            const cy = y - c.base.w / 2;
            let z = 0;
            for (const b of [c.base, ...c.stack]) {
                z += b.pillar;
                placed.push({
                    row: b,
                    preset: BOARD_PRESETS[b.preset] ?? BOARD_PRESETS["custom"],
                    x: x + c.base.l / 2,
                    y: cy,
                    z,
                    edge: i === 0 && b === c.base && r.port > 0,
                });
                z += 1.6 + b.comp;
            }
            x += lenOf(c.base) + o.gap;
        });
        y -= r.wid + o.gap;
    }
    const x0 = -lidL / 2;
    const sx = sc ? x0 + sc.w / 2 : 0;
    const rx = rd ? x0 + (sc ? sc.w + lidGap : 0) + rd.w / 2 : 0;
    return { L, W, H, hMin, needL, needW, placed, zone, lidL, sx, rx };
}

function round(v: number) {
    return Math.round(v * 10) / 10;
}

// ------------------------------------------------------------------ hình khối
const plane = (x: number, y: number, z: number) =>
    new Plane({ origin: new XYZ(x, y, z), normal: XYZ.unitZ, xvec: XYZ.unitX });

function ok<T>(r: Result<T>, what: string): T {
    if (!r.isOk) throw new Error(`${what}: ${r.error}`);
    return r.value;
}
/** Hộp theo toạ độ góc nhỏ nhất. */
function box(x: number, y: number, z: number, dx: number, dy: number, dz: number): IShape {
    return ok(shapeFactory.box(plane(x, y, z), dx, dy, dz), "box");
}
/** Hộp theo tâm XY, đáy z. */
function cbox(cx: number, cy: number, z: number, dx: number, dy: number, dz: number): IShape {
    return box(cx - dx / 2, cy - dy / 2, z, dx, dy, dz);
}
function cyl(cx: number, cy: number, z: number, r: number, h: number): IShape {
    return ok(shapeFactory.cylinder(XYZ.unitZ, new XYZ(cx, cy, z), r, h), "cylinder");
}
/** Lăng trụ lục giác đứng (hốc đai ốc), af = cạnh đối cạnh. */
function hexPrism(cx: number, cy: number, z: number, af: number, h: number): IShape {
    const R = af / Math.sqrt(3);
    const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i;
        return new XYZ(cx + R * Math.cos(a), cy + R * Math.sin(a), z);
    });
    pts.push(pts[0]!);
    const wire = ok(shapeFactory.polygon(pts), "polygon");
    const face = ok(shapeFactory.face([wire]), "face");
    return ok(shapeFactory.prism(face, new XYZ(0, 0, h)), "prism");
}
function fuse(a: IShape, tools: IShape[]): IShape {
    if (!tools.length) return a;
    return ok(shapeFactory.booleanFuse([a], tools, true), "fuse");
}
function cut(a: IShape, tools: IShape[]): IShape {
    if (!tools.length) return a;
    return ok(shapeFactory.booleanCut([a], tools), "cut");
}

export function buildEnclosure(o: EnclosureOptions) {
    const lay = layoutEnclosure(o);
    const { L, W, H, placed, zone } = lay;
    const t = o.wall;
    const Lo = L + 2 * t;
    const Wo = W + 2 * t;
    const sc = SCREEN_PRESETS[o.screen] ?? null;
    const rd = READER_PRESETS[o.reader] ?? null;
    const bx = L / 2 - 3.2;
    const by = W / 2 - 3.2;
    const corners = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
    ];

    // ---- Thân hộp
    let body = cut(box(-Lo / 2, -Wo / 2, 0, Lo, Wo, t + H), [box(-L / 2, -W / 2, t, L, W, H + 1)]);
    const add: IShape[] = [];
    if (o.screws) for (const [a, b] of corners) add.push(cyl(a * bx, b * by, t, o.lidInsert ? 3.6 : 3.2, H));
    // ---- chân bắt bo: cọc vít đúng lỗ trên bo, hoặc chốt kẹp góc cho bo không có lỗ
    const screw = screwOf(o);
    const pilotHoles: IShape[] = [];
    for (const p of placed) {
        if (p.z !== p.row.pillar) continue; // bo chồng lên bo khác thì không cần chân
        const m = mountOf(p.row);
        const x0 = p.x - p.row.l / 2;
        const y0 = p.y - p.row.w / 2;
        const pil = p.row.pillar;
        if (m === "clips") {
            // đệm đỡ dưới 4 góc + 2 thanh chặn hình chữ L ở mỗi góc, cao hơn mặt bo 1.5 mm
            const lip = 1.6;
            const gapE = 0.3;
            const len = 6;
            const hTop = pil + 1.6 + 1.5;
            const portEnd = p.edge && portsOf(p.row).length > 0;
            for (const [cx, sx] of [
                [x0, -1],
                [x0 + p.row.l, 1],
            ] as const) {
                for (const [cy, sy] of [
                    [y0, -1],
                    [y0 + p.row.w, 1],
                ] as const) {
                    if (pil > 0) add.push(cbox(cx - sx * 2.5, cy - sy * 2.5, t, 5, 5, pil));
                    if (portEnd && sx < 0) continue; // đầu có cổng tựa vào thành hộp
                    if (sx > 0 && tailOf(p.row) > 0) {
                        // đầu có anten thò ra: chỉ chặn hai bên cạnh, không chặn đầu bo
                        add.push(box(cx - len, sy > 0 ? cy + gapE : cy - gapE - lip, t, len, lip, hTop));
                        continue;
                    }
                    // chặn theo chiều dài (đầu bo)
                    add.push(
                        box(sx > 0 ? cx + gapE : cx - gapE - lip, sy > 0 ? cy - len : cy, t, lip, len, hTop),
                    );
                    // chặn theo chiều rộng (cạnh bo)
                    add.push(
                        box(sx > 0 ? cx - len : cx, sy > 0 ? cy + gapE : cy - gapE - lip, t, len, lip, hTop),
                    );
                }
            }
            continue;
        }
        if (m === "none" || pil <= 0) {
            if (pil > 0)
                for (const a of [-1, 1])
                    for (const b of [-1, 1])
                        add.push(
                            cbox(p.x + a * (p.row.l / 2 - 2), p.y + b * (p.row.w / 2 - 2), t, 4, 4, pil),
                        );
            continue;
        }
        for (const [hx, hy] of mountHoles(p.row)) {
            const wx = x0 + hx;
            const wy = y0 + hy;
            const r = screw.d / 2;
            switch (screw.kind) {
                case "insert": {
                    // lỗ cấy đai ốc đồng từ mặt cọc xuống; cọc to hơn để thành lỗ đủ dày
                    add.push(cyl(wx, wy, t, screw.boss ?? 3.7, pil));
                    const depth = screw.depth ?? 5;
                    const z0 = Math.max(0.6, t + pil - depth);
                    pilotHoles.push(cyl(wx, wy, z0, r, t + pil - z0 + 1));
                    break;
                }
                case "nut": {
                    // vít xuyên từ trên bo xuống, đai ốc lục giác nằm trong hốc dưới đáy hộp
                    add.push(cyl(wx, wy, t, screw.boss ?? 3.3, pil));
                    pilotHoles.push(cyl(wx, wy, -1, r, t + pil + 2));
                    pilotHoles.push(hexPrism(wx, wy, -0.01, screw.af ?? 5.9, (screw.nh ?? 2.6) + 0.01));
                    break;
                }
                case "brass": {
                    // trụ đồng bắt bằng vít từ dưới đáy lên; chỉ cần lỗ xuyên + hốc chìm đầu vít, thêm vòng định vị thấp
                    add.push(cyl(wx, wy, t, r + 1.2, 0.8));
                    pilotHoles.push(cyl(wx, wy, -1, r, t + 3));
                    const [cbd, cbh] = screw.cb ?? [6, 1.6];
                    pilotHoles.push(cyl(wx, wy, -0.01, cbd / 2, Math.min(cbh, t - 0.6) + 0.01));
                    break;
                }
                default:
                    add.push(cyl(wx, wy, t, 3, pil));
                    pilotHoles.push(cyl(wx, wy, t + 0.8, r, pil + 1));
            }
        }
    }
    body = fuse(body, add);
    const holes: IShape[] = [...pilotHoles];
    if (o.screws)
        for (const [a, b] of corners)
            holes.push(
                o.lidInsert
                    ? cyl(a * bx, b * by, t + H - 6, 2.0, 7) // đai ốc cấy nhiệt M3 (lỗ Ø4.0, sâu 6)
                    : cyl(a * bx, b * by, t + 1.5, 1.3, H), // vít tự ren M3
            );
    if (o.usb)
        for (const p of placed) {
            if (!p.edge) continue;
            for (const port of portsOf(p.row)) {
                const yc = p.y + port.offset;
                const zc = t + p.z + 1.6 + port.z;
                for (const c of port.cuts) {
                    const y = yc + (c.dx ?? 0);
                    if (c.shape === "circle")
                        holes.push(
                            ok(
                                shapeFactory.cylinder(
                                    XYZ.unitX,
                                    new XYZ(-L / 2 - t - 1, y, zc),
                                    c.w / 2,
                                    t + 2,
                                ),
                                "port",
                            ),
                        );
                    else
                        holes.push(cbox(-L / 2 - t / 2, y, Math.max(t + 0.6, zc - c.h / 2), t + 2, c.w, c.h));
                }
            }
        }
    if (o.vents) {
        const n = Math.max(0, Math.min(14, Math.floor((L - 24) / 5)));
        const vh = Math.min(12, H * 0.35);
        for (let i = 0; i < n; i++) {
            const x = -(n - 1) * 2.5 + i * 5;
            // chỉ khoét khe ở mặt sau, để mặt trước trống cho nút bấm, đèn, cổng
            holes.push(cbox(x, W / 2 + t / 2, t + H * 0.6 - vh / 2, 2, t + 2, vh));
        }
    }
    body = cut(body, holes);

    // ---- Nắp
    const top = t + H;
    const pt = Math.min(1.2, t - 0.4);
    let lid = box(-Lo / 2, -Wo / 2, top, Lo, Wo, t);
    // gờ khớp nắp (lọt vào trong thành, hở 0.3 mm)
    let lip = cut(box(-L / 2 + 0.3, -W / 2 + 0.3, top - 3, L - 0.6, W - 0.6, 3), [
        box(-L / 2 + 1.5, -W / 2 + 1.5, top - 3.5, L - 3, W - 3, 4),
    ]);
    if (o.screws)
        lip = cut(
            lip,
            corners.map(([a, b]) => cbox(a * bx, b * by, top - 4, 13, 13, 5)),
        );
    lid = fuse(lid, [lip]);
    const lidCuts: IShape[] = [];
    if (sc)
        lidCuts.push(
            sc.round
                ? cyl(lay.sx + (sc.wdx ?? 0), 0, top - 1, sc.win[0] / 2, t + 2)
                : cbox(lay.sx + (sc.wdx ?? 0), 0, top - 1, sc.win[0], sc.win[1], t + 2),
        );
    if (rd) lidCuts.push(cbox(lay.rx, 0, top - 1, rd.w - 5, rd.h - 5, 1 + t - pt));
    if (o.screws) for (const [a, b] of corners) lidCuts.push(cyl(a * bx, b * by, top - 1, 1.7, t + 2));
    lid = cut(lid, lidCuts);
    const so: IShape[] = [];
    const soHoles: IShape[] = [];
    /** Cọc bắt màn hình / đầu đọc thẻ thả từ nắp xuống: lỗ mồi vít tự ren, hoặc lỗ cấy đai ốc đồng (có ren). */
    const lidPost = (cx: number, cy: number, z0: number, zTop: number, hr: number, roof: number) => {
        if (o.screenInsert) {
            // cỡ đai ốc theo lỗ trên bo: Ø3.2 → M3, Ø2.5–3 → M2.5, nhỏ hơn → M2
            const [d, depth] = hr >= 1.5 ? [4.0, 5.5] : hr >= 1.2 ? [3.6, 5] : [3.2, 4];
            so.push(cyl(cx, cy, z0, Math.max(hr + 1.1, d / 2 + 1.4), zTop - z0 + 0.01));
            const zEnd = Math.min(z0 + depth, roof - 0.6);
            soHoles.push(cyl(cx, cy, z0 - 0.5, d / 2, zEnd - z0 + 0.5));
        } else {
            so.push(cyl(cx, cy, z0, hr + 1.1, zTop - z0 + 0.01));
            soHoles.push(cyl(cx, cy, z0 - 0.5, hr * 0.8, Math.min(zTop - z0 + 0.5, roof - 0.6 - z0 + 0.5)));
        }
    };
    if (sc?.holes)
        for (const a of [-1, 1])
            for (const b of [-1, 1])
                lidPost(lay.sx + (a * sc.holes[0]) / 2, (b * sc.holes[1]) / 2, top - sc.so, top, sc.hr, top + t);
    else if (sc) {
        // bo không có lỗ bắt: 4 gờ chữ L ôm góc bo, thả từ nắp xuống quá mặt dưới bo 1 mm (dán keo / băng keo 2 mặt)
        const gl = Math.min(6, sc.w / 3, sc.h / 3);
        const hh = sc.so + 1.6 + 1;
        const gap = 0.3;
        const lip = 1.2;
        for (const a of [-1, 1])
            for (const b of [-1, 1]) {
                const ex = lay.sx + (a * sc.w) / 2;
                const ey = (b * sc.h) / 2;
                const ox = a > 0 ? ex + gap : ex - gap - lip;
                const oy = b > 0 ? ey + gap : ey - gap - lip;
                so.push(box(ox, b > 0 ? ey - gl : ey, top - hh, lip, gl + gap + lip, hh + 0.01));
                so.push(box(a > 0 ? ex - gl : ex, oy, top - hh, gl + gap + lip, lip, hh + 0.01));
            }
    }
    if (rd) {
        const ceil = top + t - pt;
        for (const a of [-1, 1])
            for (const b of [-1, 1])
                lidPost(lay.rx + (a * rd.holes[0]) / 2, (b * rd.holes[1]) / 2, top - rd.so, ceil, rd.hr, ceil + pt);
    }
    lid = cut(fuse(lid, so), soHoles);

    // ---- Linh kiện tham khảo (không in)
    const parts: { name: string; shape: IShape; kind: PartKind }[] = [];
    if (o.parts) {
        for (const p of placed) {
            parts.push({
                name: p.preset.name,
                kind: "pcb",
                shape: cbox(p.x, p.y, t + p.z, p.row.l, p.row.w, 1.6),
            });
            if (p.row.comp > 0)
                parts.push({
                    name: `${p.preset.name} (linh kiện)`,
                    kind: "comp",
                    shape: cbox(p.x, p.y, t + p.z + 1.6, p.row.l * 0.85, p.row.w * 0.8, p.row.comp),
                });
        }
        for (const p of placed) {
            const tail = tailOf(p.row);
            if (tail > 0)
                parts.push({
                    name: `${p.preset.name} (vùng anten WiFi — để trống)`,
                    kind: "port",
                    shape: cbox(
                        p.x + p.row.l / 2 + tail / 2,
                        p.y,
                        t + p.z + 1.6,
                        tail,
                        Math.min(18, p.row.w),
                        3,
                    ),
                });
        }
        for (const p of placed) {
            if (!p.edge) continue;
            for (const port of portsOf(p.row)) {
                if (!port.body) continue;
                const [depth, bw, bh] = port.body;
                const x0 = p.x - p.row.l / 2 - port.overhang;
                parts.push({
                    name: `${p.preset.name} (cổng ${port.name})`,
                    kind: "port",
                    shape: box(x0, p.y + port.offset - bw / 2, t + p.z + 1.6, depth, bw, bh),
                });
            }
        }
        if (sc)
            parts.push({
                name: sc.name,
                kind: "screen",
                shape: cbox(lay.sx, 0, top - sc.so - 1.6, sc.w, sc.h, 1.6),
            });
        if (rd)
            parts.push({
                name: rd.name,
                kind: "pcb",
                shape: cbox(lay.rx, 0, top - rd.so - 1.6, rd.w, rd.h, 1.6),
            });
    }
    return { body, lid, parts, lay, outer: [Lo, Wo, H + 2 * t] };
}

// ------------------------------------------------------------------ màu linh kiện tham khảo
type PartKind = "pcb" | "comp" | "port" | "screen";
const PART_MATERIALS: Record<PartKind, [string, number, number]> = {
    pcb: ["Bo mạch (tham khảo, không in)", 0x2e9e5b, 0.55],
    comp: ["Linh kiện (tham khảo, không in)", 0x3d7bd9, 0.4],
    port: ["Cổng (tham khảo, không in)", 0xd9a33d, 0.6],
    screen: ["Màn hình (tham khảo, không in)", 0x1f2f6b, 0.6],
};

/** Vật liệu màu trong suốt cho linh kiện tham khảo, để không nhầm với phần được in. */
function partMaterial(document: IDocument, kind: PartKind): string {
    const [name, color, opacity] = PART_MATERIALS[kind];
    const mats = document.modelManager.materials;
    for (let i = 0; i < mats.length; i++) {
        const m = mats.at(i);
        if (m?.name === name) return m.id;
    }
    const m = new Material({ document, name, color });
    m.opacity = opacity;
    mats.push(m);
    return m.id;
}

function addParts(
    document: IDocument,
    folder: FolderNode,
    parts: { name: string; shape: IShape; kind: PartKind }[],
) {
    for (const p of parts)
        folder.add(
            new EditableShapeNode({
                document,
                name: p.name,
                shape: p.shape,
                materialId: partMaterial(document, p.kind),
            }),
        );
}

// ------------------------------------------------------------------ thư mục hộp, nhớ thông số để sửa lại
export interface BlockSpec {
    id: string;
    type: "hollow" | "solid" | "cyl";
    x: number;
    y: number;
    w: number;
    d: number;
    h: number;
    thru: boolean;
}

export interface EnclosureParams {
    o: EnclosureOptions;
    holes: HoleSpec[];
    blocks: BlockSpec[];
}

@serializable()
export class EnclosureFolder extends FolderNode {
    constructor(options: FolderNodeOptions) {
        super(options);
    }

    /** JSON của EnclosureParams: thông số hộp + danh sách lỗ, để sửa và dời lỗ sau khi tạo. */
    @serialize()
    get params(): string {
        return this.getPrivateValue("params" as any, "") as string;
    }
    set params(value: string) {
        this.setProperty("params" as any, value);
    }

    get data(): EnclosureParams | undefined {
        try {
            const d = JSON.parse(this.params);
            if (d?.o)
                return {
                    o: d.o,
                    holes: Array.isArray(d.holes) ? d.holes : [],
                    blocks: Array.isArray(d.blocks) ? d.blocks : [],
                };
        } catch {}
        return undefined;
    }
}

/** Thân + nắp đã khoét đủ các lỗ trong danh sách. */
export function buildAll(o: EnclosureOptions, holes: HoleSpec[], blocks: BlockSpec[] = []) {
    const r = buildEnclosure(o);
    if (blocks.length) {
        const bb = r.lid.boundingBox();
        const cx = (bb.min.x + bb.max.x) / 2;
        const cy = (bb.min.y + bb.max.y) / 2;
        const top = bb.max.z;
        const bt = Math.max(1.2, o.wall);
        const adds: IShape[] = [];
        const thru: IShape[] = [];
        for (const k of blocks) {
            const x = cx + k.x;
            const y = cy + k.y;
            const w = Math.max(2, k.w);
            const d = k.type === "cyl" ? w : Math.max(2, k.d);
            const h = Math.max(1, k.h);
            if (k.type === "cyl") adds.push(cyl(x, y, top - 0.01, w / 2, h + 0.01));
            else if (k.type === "solid" || w - 2 * bt < 1 || d - 2 * bt < 1 || h <= bt + 0.5)
                adds.push(cbox(x, y, top - 0.01, w, d, h + 0.01));
            else {
                adds.push(
                    cut(cbox(x, y, top - 0.01, w, d, h + 0.01), [
                        cbox(x, y, top - 1, w - 2 * bt, d - 2 * bt, h - bt + 1),
                    ]),
                );
                if (k.thru) thru.push(cbox(x, y, top - o.wall - 1, w - 2 * bt, d - 2 * bt, o.wall + 1.5));
            }
        }
        r.lid = cut(fuse(r.lid, adds), thru);
    }
    const bodyHoles = holes.filter((h) => h.face !== "lid");
    const lidHoles = holes.filter((h) => h.face === "lid");
    if (bodyHoles.length) {
        const bb = r.body.boundingBox();
        r.body = cut(
            r.body,
            bodyHoles.flatMap((h) => holeTools(h, bb, o.wall)),
        );
    }
    if (lidHoles.length) {
        const bb = r.lid.boundingBox();
        r.lid = cut(
            r.lid,
            lidHoles.flatMap((h) => holeTools(h, bb, o.wall)),
        );
    }
    return r;
}

const enclosureName = (outer: number[]) => `Hộp mạch ${outer.map((v) => v.toFixed(0)).join("×")}`;

// ------------------------------------------------------------------ hộp thoại
const STORE_KEY = "chili3d-vi.enclosure";

function loadOptions(): EnclosureOptions {
    try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
        if (s && Array.isArray(s.boards)) return { ...DEFAULT_ENCLOSURE, ...s };
    } catch {}
    return structuredClone(DEFAULT_ENCLOSURE);
}

const CSS = `
.encl{display:grid;gap:10px;min-width:min(560px,88vw);max-height:70vh;overflow:auto;font-size:13px;padding:2px 4px}
.encl [hidden]{display:none!important}
.encl h4{margin:6px 0 0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;opacity:.7}
.encl .row{display:grid;grid-template-columns:2fr repeat(4,minmax(46px,1fr)) 1.5fr minmax(46px,.8fr) auto auto;gap:6px;align-items:end}
.encl .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.encl label{display:grid;gap:2px;font-size:11px;opacity:.95}
.encl input[type=number],.encl select{font:inherit;padding:4px 6px;min-width:0;width:100%;box-sizing:border-box}
.encl .chk{display:flex;gap:6px;align-items:center;font-size:12px}
.encl button.small{font:inherit;padding:4px 8px;cursor:pointer}
.encl .info{padding:8px;border-radius:6px;background:rgba(127,127,127,.12);font-variant-numeric:tabular-nums}
.encl .warn{color:#c47a00}
`;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
    ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const e: HTMLElementTagNameMap[K] = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
}

function numInput(label: string, value: number, onChange: (v: number) => void, step = 0.5) {
    const i = el("input", { type: "number", step: String(step), value: String(value) });
    i.addEventListener("input", () => {
        const v = Number.parseFloat(i.value);
        if (!Number.isNaN(v)) onChange(v);
    });
    return el("label", {}, label, i);
}

function select(label: string, value: string, options: [string, string][], onChange: (v: string) => void) {
    const s = el("select");
    for (const [k, n] of options) s.append(el("option", { value: k, textContent: n, selected: k === value }));
    s.addEventListener("change", () => onChange(s.value));
    return label ? el("label", {}, label, s) : s;
}

function check(label: string, value: boolean, onChange: (v: boolean) => void) {
    const c = el("input", { type: "checkbox", checked: value });
    c.addEventListener("change", () => onChange(c.checked));
    return el("label", { className: "chk" }, c, label);
}

function buildForm(o: EnclosureOptions, withSize = true) {
    const root = el("div", { className: "encl" });
    root.append(el("style", { textContent: CSS }));
    const boardsBox = el("div", { style: "display:grid;gap:6px" });
    const info = el("div", { className: "info" });
    const manBox = el("div", { className: "grid" });
    const autoChk = el("input", { type: "checkbox", checked: !o.manual });
    autoChk.addEventListener("change", () => {
        o.manual = !autoChk.checked;
        refresh();
    });
    let sizeInputs: HTMLInputElement[] = [];

    const refresh = () => {
        const lay = layoutEnclosure(o);
        const t = o.wall;
        const warn: string[] = [];
        if (o.manual) {
            if (lay.L < lay.needL) warn.push(`dài nên ≥ ${lay.needL} mm`);
            if (lay.W < lay.needW) warn.push(`rộng nên ≥ ${lay.needW} mm`);
            if (lay.H < lay.hMin) warn.push(`cao nên ≥ ${lay.hMin} mm`);
        }
        info.replaceChildren(
            `Kích thước ngoài: ${(lay.L + 2 * t).toFixed(1)} × ${(lay.W + 2 * t).toFixed(1)} × ${(lay.H + 2 * t).toFixed(1)} mm · trong lòng ${lay.L.toFixed(1)} × ${lay.W.toFixed(1)} × ${lay.H.toFixed(1)} mm · ${o.boards.length} bo`,
            ...(warn.length
                ? [el("div", { className: "warn", textContent: `Hộp nhỏ hơn linh kiện: ${warn.join(", ")}` })]
                : []),
        );
        // ô Dài / Rộng / Cao luôn hiện: tự tính thì hiện số máy tính ra, gõ vào là chuyển sang tự nhập
        autoChk.checked = !o.manual;
        const vals = [lay.L, lay.W, lay.H];
        sizeInputs.forEach((inp, i) => {
            if (window.document.activeElement !== inp) inp.value = String(round(vals[i]!));
        });
    };

    const renderBoards = () => {
        boardsBox.replaceChildren(
            ...o.boards.map((b, i) => {
                const pick = select(
                    "Bo mạch",
                    b.preset,
                    Object.entries(BOARD_PRESETS).map(([k, p]) => [k, p.name]),
                    (v) => {
                        const p = BOARD_PRESETS[v];
                        Object.assign(b, {
                            preset: v,
                            l: p.l,
                            w: p.w,
                            pillar: p.pillar,
                            comp: p.comp,
                            mount: undefined,
                            inset: undefined,
                            portsOff: undefined,
                        });
                        renderBoards();
                        renderBoards();
                        refresh();
                    },
                );
                const del = el("button", {
                    className: "small",
                    type: "button",
                    textContent: "Xoá",
                    title: "Xoá bo này",
                });
                del.addEventListener("click", () => {
                    o.boards.splice(i, 1);
                    renderBoards();
                    refresh();
                });
                return el(
                    "div",
                    { className: "row" },
                    pick,
                    numInput("Dài", b.l, (v) => ((b.l = v), refresh())),
                    numInput("Rộng", b.w, (v) => ((b.w = v), refresh())),
                    numInput("Cọc đỡ", b.pillar, (v) => ((b.pillar = v), refresh())),
                    numInput("Cao linh kiện", b.comp, (v) => ((b.comp = v), refresh())),
                    select("Chân bắt", mountOf(b), MOUNT_NAMES, (v) => {
                        b.mount = v as MountKind;
                        refresh();
                    }),
                    numInput("Lỗ cách mép", insetOf(b), (v) => ((b.inset = v), refresh())),
                    ...allPortsOf(b).map((port) =>
                        check(`Khoét cổng ${port.name}`, !b.portsOff?.includes(port.name), (v) => {
                            const off = new Set(b.portsOff ?? []);
                            if (v) off.delete(port.name);
                            else off.add(port.name);
                            b.portsOff = [...off];
                            refresh();
                        }),
                    ),
                    i > 0
                        ? check("Chồng lên bo trên", b.stack, (v) => ((b.stack = v), refresh()))
                        : el("span"),
                    del,
                );
            }),
        );
    };

    const addBtn = el("button", { className: "small", type: "button", textContent: "+ Thêm bo mạch" });
    addBtn.addEventListener("click", () => {
        const p = BOARD_PRESETS["relay1"];
        o.boards.push({ preset: "relay1", l: p.l, w: p.w, pillar: p.pillar, comp: p.comp, stack: false });
        renderBoards();
        refresh();
    });

    const setSize = (key: "manL" | "manW" | "manH", v: number) => {
        if (!o.manual) {
            const lay = layoutEnclosure(o);
            Object.assign(o, { manual: true, manL: lay.L, manW: lay.W, manH: lay.H });
        }
        o[key] = v;
        refresh();
    };
    const sizeFields = [
        numInput("Dài (mm)", o.manL, (v) => setSize("manL", v), 1),
        numInput("Rộng (mm)", o.manW, (v) => setSize("manW", v), 1),
        numInput("Cao (mm)", o.manH, (v) => setSize("manH", v), 1),
    ];
    sizeInputs = sizeFields.map((f) => f.querySelector("input") as HTMLInputElement);
    manBox.append(...sizeFields);

    root.append(
        el("h4", {
            textContent: "Bo mạch trong hộp (tự xếp cạnh nhau, đánh dấu “chồng” nếu cắm chồng lên nhau)",
        }),
        boardsBox,
        addBtn,
        el("h4", { textContent: "Gắn dưới nắp" }),
        el(
            "div",
            { className: "grid" },
            select(
                "Màn hình",
                o.screen,
                Object.entries(SCREEN_PRESETS).map(([k, p]) => [
                    k,
                    p ? `${p.group ? `${p.group}: ` : ""}${p.name}` : "Không có",
                ]),
                (v) => ((o.screen = v), refresh()),
            ),
            select(
                "Đầu đọc thẻ",
                o.reader,
                Object.entries(READER_PRESETS).map(([k, p]) => [k, p?.name ?? "Không có"]),
                (v) => ((o.reader = v), refresh()),
            ),
        ),
        ...(withSize
            ? [
                  el("h4", { textContent: "Kích thước hộp (trong lòng, mm)" }),
                  manBox,
                  el(
                      "label",
                      { className: "chk" },
                      autoChk,
                      "Tự tính vừa với bo mạch (gõ số vào ô trên là tự chuyển sang kích thước của anh)",
                  ),
              ]
            : []),
        el("h4", { textContent: "Hộp" }),
        el(
            "div",
            { className: "grid" },
            numInput("Dày thành (mm)", o.wall, (v) => ((o.wall = Math.max(1.2, v)), refresh()), 0.2),
            numInput("Hở quanh bo (mm)", o.clear, (v) => ((o.clear = Math.max(0.5, v)), refresh())),
            numInput("Cách giữa các bo (mm)", o.gap, (v) => ((o.gap = Math.max(0, v)), refresh())),
            select(
                "Vít bắt bo",
                o.screw ?? "m3",
                Object.entries(SCREW_PILOT).map(([k, v]) => [k, v.name]),
                (v) => ((o.screw = v), refresh()),
            ),
        ),
        el(
            "div",
            { className: "grid" },
            check("4 vít M3 ở góc", o.screws, (v) => ((o.screws = v), refresh())),
            check("Vít nắp dùng đai ốc cấy nhiệt M3", !!o.lidInsert, (v) => ((o.lidInsert = v), refresh())),
            check("Cọc màn hình / đầu đọc thẻ dùng đai ốc cấy nhiệt", !!o.screenInsert, (v) => ((o.screenInsert = v), refresh())),
            check("Tự khoét lỗ cổng (USB, LAN, DB9) ở thành trái", o.usb, (v) => ((o.usb = v), refresh())),
            check("Khe tản nhiệt (mặt sau)", o.vents, (v) => (o.vents = v)),
            check("Hiện linh kiện tham khảo", o.parts, (v) => (o.parts = v)),
        ),
        info,
    );
    renderBoards();
    refresh();
    return root;
}

@command({
    key: "enclosure.create" as any,
    icon: "icon-box",
})
export class CreateEnclosureCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (!document) {
            PubSub.default.pub("showToast", "toast.document.noActivated");
            return;
        }
        const o = loadOptions();
        PubSub.default.pub("showDialog", "command.enclosure.create" as any, buildForm(o), () => {
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify(o));
            } catch {}
            this.create(document, o);
        });
    }

    private create(document: IDocument, o: EnclosureOptions) {
        if (!o.boards.length && SCREEN_PRESETS[o.screen] == null && READER_PRESETS[o.reader] == null) {
            PubSub.default.pub("showToast", "error.default:{0}", "Chưa có bo mạch hay linh kiện nào");
            return;
        }
        let r: ReturnType<typeof buildEnclosure>;
        try {
            r = buildEnclosure(o);
        } catch (e) {
            PubSub.default.pub("showToast", "error.default:{0}", String((e as Error).message ?? e));
            return;
        }
        Transaction.execute(document, "create enclosure", () => {
            const folder = new EnclosureFolder({ document, name: enclosureName(r.outer) });
            folder.params = JSON.stringify({ o, holes: [], blocks: [] } satisfies EnclosureParams);
            document.modelManager.rootNode.add(folder);
            folder.add(new EditableShapeNode({ document, name: "Thân hộp", shape: r.body }));
            folder.add(new EditableShapeNode({ document, name: "Nắp hộp", shape: r.lid }));
            if (r.parts.length) {
                const pf = new FolderNode({ document, name: "Linh kiện tham khảo (không in)" });
                folder.add(pf);
                addParts(document, pf, r.parts);
            }
            document.visual.update();
        });
        document.application.activeView?.cameraController.fitContent();
        // mở luôn bảng "Làm hộp" để thêm lỗ, khối
        openEditor(document.application);
    }
}

// ------------------------------------------------------------------ xuất STL để in
const isLid = (name: string) => /nắp|nap|lid/i.test(name);

/** Hộp mạch gần nhất trong bản vẽ (thư mục tên "Hộp mạch ..."). */
function findEnclosureFolders(document: IDocument): FolderNode[] {
    const out: FolderNode[] = [];
    const walk = (n: INode | undefined) => {
        for (let c = n instanceof FolderNode ? n.firstChild : undefined; c; c = c.nextSibling) {
            if (c instanceof FolderNode) {
                if (c.name.startsWith("Hộp mạch")) out.push(c);
                walk(c);
            }
        }
    };
    walk(document.modelManager.rootNode);
    return out;
}

function printableIn(folder: FolderNode): ShapeNode[] {
    const out: ShapeNode[] = [];
    for (let c = folder.firstChild; c; c = c.nextSibling) if (c instanceof ShapeNode) out.push(c);
    return out;
}

function safeFileName(s: string) {
    return s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "khoi";
}

@command({
    key: "enclosure.exportStl" as any,
    icon: "icon-export",
})
export class ExportEnclosureStlCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (!document) {
            PubSub.default.pub("showToast", "toast.document.noActivated");
            return;
        }
        let nodes = document.selection
            .getSelectedNodes()
            .filter((x): x is ShapeNode => x instanceof ShapeNode);
        if (!nodes.length) {
            const folders = findEnclosureFolders(document);
            const last = folders[folders.length - 1];
            if (last) nodes = printableIn(last);
        }
        if (!nodes.length) {
            PubSub.default.pub(
                "showToast",
                "toast.message{0}" as any,
                "Chưa có hộp mạch. Tạo hộp hoặc chọn khối cần xuất trước.",
            );
            return;
        }
        let count = 0;
        let folderPath = "";
        for (const node of nodes) {
            if (!node.shape.isOk) continue;
            const world = node.shape.value.transformedMul(node.worldTransform());
            let shape = world;
            if (isLid(node.name)) {
                // Lật úp nắp: mặt trên xuống bàn in
                shape = world.transformedMul(Matrix4.fromAxisRad(XYZ.zero, XYZ.unitX, Math.PI));
                world.dispose();
            }
            const stl = shapeConverter.convertToSTL([shape], { binary: true });
            shape.dispose();
            if (!stl.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", `${node.name}: ${stl.error}`);
                continue;
            }
            const fname = `${safeFileName(document.name)} - ${safeFileName(node.name)}.stl`;
            const saved = await saveToProjectFolder(fname, stl.value as BlobPart, "export").catch(
                () => undefined,
            );
            if (saved) folderPath = saved.replace(/[\\/][^\\/]*$/, "");
            else {
                download([stl.value as BlobPart], fname);
                await new Promise((r) => setTimeout(r, 400));
            }
            count++;
        }
        if (count && folderPath) {
            PubSub.default.pub(
                "showToast",
                "toast.message{0}" as any,
                `Đã lưu ${count} file STL vào ${folderPath} (nắp đã lật úp sẵn để in)`,
            );
            void fetch("/api/open-folder?sub=STL", { method: "POST" });
        } else if (count)
            PubSub.default.pub(
                "showToast",
                "toast.message{0}" as any,
                `Đã tải ${count} file STL (nắp đã lật úp sẵn để in)`,
            );
    }
}

// ------------------------------------------------------------------ khoét lỗ nhanh
type HoleFace = "lid" | "front" | "back" | "left" | "right" | "bottom";
interface HoleOptions {
    face: HoleFace;
    preset: string;
    shape: "circle" | "rect";
    x: number;
    y: number;
    w: number;
    h: number;
    count: number;
    pitch: number;
}

export interface HoleSpec extends HoleOptions {
    id: string;
}

const HOLE_PRESETS: Record<string, { name: string; shape: "circle" | "rect"; w: number; h: number }> = {
    custom: { name: "Tự nhập", shape: "circle", w: 6, h: 6 },
    btn12: { name: "Nút nhấn Ø12", shape: "circle", w: 12.2, h: 12.2 },
    btn16: { name: "Nút nhấn Ø16", shape: "circle", w: 16.2, h: 16.2 },
    btn6: { name: "Nút bấm 6×6 (lỗ cần Ø4)", shape: "circle", w: 4, h: 4 },
    led5: { name: "Đèn LED 5mm", shape: "circle", w: 5.2, h: 5.2 },
    led3: { name: "Đèn LED 3mm", shape: "circle", w: 3.2, h: 3.2 },
    dc55: { name: "Jack nguồn DC 5.5mm", shape: "circle", w: 8, h: 8 },
    gx12: { name: "Jack GX12 / chiết áp", shape: "circle", w: 12.2, h: 12.2 },
    kcd1: { name: "Công tắc bập bênh KCD1", shape: "rect", w: 19.2, h: 13.2 },
    usbc: { name: "Cổng USB-C", shape: "rect", w: 10, h: 4.5 },
    microusb: { name: "Cổng Micro USB", shape: "rect", w: 9, h: 4.5 },
    rj45: { name: "Cổng mạng RJ45", shape: "rect", w: 16.5, h: 14 },
    cable: { name: "Lỗ luồn dây Ø6", shape: "circle", w: 6, h: 6 },
    m3: { name: "Lỗ vít M3", shape: "circle", w: 3.4, h: 3.4 },
    antenna: { name: "Ăng-ten SMA", shape: "circle", w: 6.6, h: 6.6 },
};

const HOLE_KEY = "chili3d-vi.hole";
function loadHole(): HoleOptions {
    const d: HoleOptions = {
        face: "front",
        preset: "btn12",
        shape: "circle",
        x: 0,
        y: 15,
        w: 12.2,
        h: 12.2,
        count: 1,
        pitch: 20,
    };
    try {
        const s = JSON.parse(localStorage.getItem(HOLE_KEY) ?? "null");
        if (s && typeof s === "object") return { ...d, ...s };
    } catch {}
    return d;
}

function holeForm(o: HoleOptions, target: string) {
    const root = el("div", { className: "encl" });
    root.append(el("style", { textContent: CSS }));
    const sizeBox = el("div", { className: "grid" });
    const renderSize = () => {
        sizeBox.replaceChildren(
            numInput(o.shape === "circle" ? "Đường kính (mm)" : "Rộng (mm)", o.w, (v) => (o.w = v), 0.1),
            ...(o.shape === "rect" ? [numInput("Cao (mm)", o.h, (v) => (o.h = v), 0.1)] : []),
        );
    };
    const shapeSel = select(
        "Dạng lỗ",
        o.shape,
        [
            ["circle", "Tròn"],
            ["rect", "Chữ nhật"],
        ],
        (v) => {
            o.shape = v as HoleOptions["shape"];
            renderSize();
        },
    );
    root.append(
        el("div", { className: "info", textContent: `Áp vào: ${target}` }),
        el(
            "div",
            { className: "grid" },
            select(
                "Mặt",
                o.face,
                [
                    ["lid", "Nắp (nhìn từ trên)"],
                    ["front", "Mặt trước"],
                    ["back", "Mặt sau"],
                    ["left", "Bên trái"],
                    ["right", "Bên phải"],
                    ["bottom", "Đáy (toạ độ như nắp)"],
                ],
                (v) => (o.face = v as HoleFace),
            ),
            select(
                "Mẫu lỗ",
                o.preset,
                Object.entries(HOLE_PRESETS).map(([k, p]) => [k, p.name]),
                (v) => {
                    const p = HOLE_PRESETS[v];
                    o.preset = v;
                    if (p && v !== "custom") Object.assign(o, { shape: p.shape, w: p.w, h: p.h });
                    (shapeSel.querySelector("select") as HTMLSelectElement).value = o.shape;
                    renderSize();
                },
            ),
            shapeSel,
        ),
        sizeBox,
        el(
            "div",
            { className: "grid" },
            numInput("X: lệch ngang so với giữa mặt (mm)", o.x, (v) => (o.x = v)),
            numInput(
                "Y: mặt bên tính từ đáy ngoài lên; nắp/đáy lệch so với giữa (mm)",
                o.y,
                (v) => (o.y = v),
            ),
        ),
        el(
            "div",
            { className: "grid" },
            numInput("Số lỗ (một hàng ngang)", o.count, (v) => (o.count = Math.max(1, Math.round(v))), 1),
            numInput("Khoảng cách tâm các lỗ (mm)", o.pitch, (v) => (o.pitch = v)),
        ),
        el("div", {
            className: "info",
            textContent:
                "Nhìn từ ngoài vào mặt đó: X dương là sang phải. Nắp: Y dương là phía sau hộp. Sai thì bấm Hoàn tác (Ctrl+Z).",
        }),
    );
    renderSize();
    return root;
}

/** Tạo khối dùng để khoét theo mặt và toạ độ, dựa trên khung bao của khối đích. */
function holeTools(o: HoleOptions, bb: { min: XYZLike; max: XYZLike }, wall: number): IShape[] {
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    const d = wall + 1.5;
    const tools: IShape[] = [];
    for (let i = 0; i < o.count; i++) {
        const u = o.x + (i - (o.count - 1) / 2) * o.pitch; // toạ độ ngang trên mặt
        const v = o.y;
        const r = o.w / 2;
        const w = o.w;
        const h = o.shape === "circle" ? o.w : o.h;
        const circle = o.shape === "circle";
        // dir: pháp tuyến hướng vào trong; p: điểm tâm lỗ trên mặt ngoài
        let dir: XYZ;
        let p: XYZ;
        let size: [number, number, number];
        switch (o.face) {
            case "lid":
            case "bottom": {
                const top = o.face === "lid";
                const z0 = bb.min.z - 1;
                const dz = top ? bb.max.z - bb.min.z + 2 : d;
                const x = cx + u;
                const y = cy + v;
                tools.push(circle ? cyl(x, y, z0, r, dz) : cbox(x, y, z0, w, h, dz));
                continue;
            }
            case "front":
                dir = XYZ.unitY;
                p = new XYZ(cx + u, bb.min.y - 1, bb.min.z + v);
                size = [w, d, h];
                break;
            case "back":
                dir = XYZ.unitNY;
                p = new XYZ(cx - u, bb.max.y + 1, bb.min.z + v);
                size = [w, d, h];
                break;
            case "left":
                dir = XYZ.unitX;
                p = new XYZ(bb.min.x - 1, cy - u, bb.min.z + v);
                size = [d, w, h];
                break;
            default:
                dir = XYZ.unitNX;
                p = new XYZ(bb.max.x + 1, cy + u, bb.min.z + v);
                size = [d, w, h];
        }
        if (circle) {
            tools.push(ok(shapeFactory.cylinder(dir, p, r, d + 1), "cylinder"));
        } else {
            const [sx, sy, sz] = size;
            const ox = dir.x > 0 ? p.x : dir.x < 0 ? p.x - sx : p.x - sx / 2;
            const oy = dir.y > 0 ? p.y : dir.y < 0 ? p.y - sy : p.y - sy / 2;
            tools.push(box(ox, oy, p.z - sz / 2, sx, sy, sz));
        }
    }
    return tools;
}

@command({
    key: "enclosure.hole" as any,
    icon: "icon-booleanCut",
})
export class EnclosureHoleCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (!document) {
            PubSub.default.pub("showToast", "toast.document.noActivated");
            return;
        }
        const selected = document.selection
            .getSelectedNodes()
            .filter((x): x is ShapeNode => x instanceof ShapeNode);
        const insideEnclosure = (n: INode) => {
            for (let p: INode | undefined = n; p; p = p.parent) if (p instanceof EnclosureFolder) return true;
            return false;
        };
        if ((selected.length !== 1 || insideEnclosure(selected[0])) && currentEnclosure(document)?.data) {
            openEditor(application, "btn12");
            return;
        }
        const folders = findEnclosureFolders(document);
        const folder = folders[folders.length - 1];
        const parts = folder ? printableIn(folder) : [];
        const body = parts.find((x) => !isLid(x.name));
        const lid = parts.find((x) => isLid(x.name));
        if (!selected.length && !body && !lid) {
            PubSub.default.pub(
                "showToast",
                "toast.message{0}" as any,
                "Chưa có hộp mạch. Tạo hộp hoặc chọn khối cần khoét trước.",
            );
            return;
        }
        const o = loadHole();
        const target =
            selected.length === 1
                ? `khối đang chọn “${selected[0].name}”`
                : `“${folder?.name ?? ""}” (mặt nắp → Nắp hộp, mặt khác → Thân hộp)`;
        PubSub.default.pub("showDialog", "command.enclosure.hole" as any, holeForm(o, target), () => {
            try {
                localStorage.setItem(HOLE_KEY, JSON.stringify(o));
            } catch {}
            const node = selected.length === 1 ? selected[0] : o.face === "lid" ? lid : body;
            if (!node) {
                PubSub.default.pub("showToast", "toast.message{0}" as any, "Không tìm thấy khối để khoét.");
                return;
            }
            this.apply(document, node, o);
        });
    }

    private apply(document: IDocument, node: ShapeNode, o: HoleOptions) {
        if (!node.shape.isOk) return;
        const world = node.shape.value.transformedMul(node.worldTransform());
        try {
            const bb = world.boundingBox();
            const tools = holeTools(o, bb, loadOptions().wall);
            const result = cut(world, tools);
            Transaction.execute(document, "enclosure hole", () => {
                const n = new EditableShapeNode({ document, name: node.name, shape: result });
                const parent = node.parent ?? document.modelManager.rootNode;
                parent.insertAfter(node, n);
                parent.remove(node);
                document.visual.update();
            });
        } catch (e) {
            PubSub.default.pub("showToast", "error.default:{0}", String((e as Error).message ?? e));
        }
    }
}

// ------------------------------------------------------------------ tháo / lắp nắp (ẩn hiện)
const LID_PART_NAMES = new Set(
    [...Object.values(SCREEN_PRESETS), ...Object.values(READER_PRESETS)].filter((x) => x).map((x) => x!.name),
);

@command({
    key: "enclosure.toggleLid" as any,
    icon: "icon-eye",
})
export class ToggleLidCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (!document) return;
        const folders = findEnclosureFolders(document);
        const folder = folders[folders.length - 1];
        const lids = folder ? printableIn(folder).filter((x) => isLid(x.name)) : [];
        if (!lids.length) {
            PubSub.default.pub("showToast", "toast.message{0}" as any, "Chưa có hộp mạch nào có nắp.");
            return;
        }
        const show = !lids[0].visible;
        const parts: INode[] = [...lids];
        // màn hình, đầu đọc thẻ gắn dưới nắp cũng ẩn/hiện theo nắp
        for (let c = folder.firstChild; c; c = c.nextSibling) {
            if (c instanceof FolderNode)
                for (let p = c.firstChild; p; p = p.nextSibling)
                    if (LID_PART_NAMES.has(p.name)) parts.push(p);
        }
        for (const n of parts) n.visible = show;
        document.selection.clearSelection();
        document.visual.update();
        PubSub.default.pub(
            "showToast",
            "toast.message{0}" as any,
            show ? "Đã lắp nắp lại" : "Đã tháo nắp — giờ bấm vào đáy hoặc thành trong để vẽ",
        );
    }
}

// ================================================================== BẢNG ĐIỀU KHIỂN DỄ DÙNG
// Bảng nổi bên phải: thêm lỗ / khối, bấm mũi tên để dời, xem kết quả ngay trên hình 3D.

const PANEL_CSS = `
.ep{position:fixed;width:340px;
 display:flex;flex-direction:column;background:var(--panel-background-color,#fff);color:var(--foreground-color,#333);
 border-left:1px solid var(--border-color,#ddd);box-shadow:-6px 0 18px rgba(0,0,0,.12);z-index:200;font-size:13px}
.ep [hidden]{display:none!important}
.ep header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border-color,#ddd)}
.ep header b{font-size:15px}
.ep .body{overflow:auto;padding:10px 12px;display:grid;gap:12px}
.ep h5{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--foreground-secondary-color,#666)}
.ep .adds{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.ep button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--border-color,#ddd);
 background:var(--button-secondary-background,#fff);color:inherit;padding:6px 8px}
.ep button:hover{background:var(--panel-hover-background-color,#f5f5f5)}
.ep button:focus-visible,.ep select:focus-visible,.ep input:focus-visible{outline:2px solid var(--primary-color,#0e62d7);outline-offset:1px}
.ep button.pri{background:var(--primary-color,#0e62d7);border-color:transparent;color:#fff;font-weight:600}
.ep .card{border:1px solid var(--border-color,#ddd);border-radius:10px;padding:8px;display:grid;gap:6px}
.ep .card.on{border-color:var(--primary-color,#0e62d7);box-shadow:0 0 0 1px var(--primary-color,#0e62d7)}
.ep .ch{display:flex;justify-content:space-between;align-items:center;gap:6px;font-weight:600}
.ep .ch span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ep .row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.ep label{display:grid;gap:2px;font-size:11px;color:var(--foreground-secondary-color,#666)}
.ep input[type=number],.ep select{font:inherit;padding:4px 6px;min-width:0;width:100%;box-sizing:border-box;
 border:1px solid var(--input-border-color,#ddd);border-radius:6px;background:var(--input-background-color,#fff);color:inherit}
.ep .pad{display:grid;grid-template-columns:repeat(3,34px);grid-template-rows:repeat(3,30px);gap:3px;justify-content:center}
.ep .pad button{padding:0;font-size:14px;line-height:1}
.ep .move{display:flex;gap:10px;align-items:center;justify-content:space-between}
.ep .steps{display:flex;gap:4px}
.ep .steps button{padding:3px 7px;font-size:12px}
.ep .steps button.on{background:var(--primary-color,#0e62d7);color:#fff;border-color:transparent}
.ep .chk{display:flex;gap:6px;align-items:center;color:inherit;font-size:12px}
.ep footer{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border-color,#ddd)}
.ep footer button{flex:1;padding:9px}
.ep .note{font-size:12px;color:var(--foreground-secondary-color,#666);margin:0}
.ep .warn{color:#c47a00}
.ep details summary{cursor:pointer;font-weight:600;padding:2px 0}
.ep .chips{display:flex;flex-wrap:wrap;gap:5px}
.ep .chip{font-size:12px;padding:4px 9px;border-radius:999px;border:1px solid var(--border-color,#ddd);background:var(--control-background-color,#f2f5f9);color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.ep button.chip:hover{border-color:var(--primary-color,#0ea5b7)}
.ep .chip.on{border-color:var(--primary-color,#0ea5b7);background:var(--title-background,#ddf4f7)}
.ep .chip.on button{border:0;background:none;padding:0 2px;font-size:11px;cursor:pointer;color:inherit}
.vb{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:40;display:flex;gap:2px;padding:4px;
 border-radius:999px;background:rgba(16,24,32,.88);border:1px solid #1f2b37;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.vb button{font:600 13px system-ui,sans-serif;color:#cfd6df;background:transparent;border:0;border-radius:999px;padding:7px 14px;cursor:pointer}
.vb button:hover{color:#fff}
.vb button.on{background:#22c3d6;color:#04161a}
.vb button.sep{margin-left:6px;border-left:1px solid rgba(255,255,255,.18);border-radius:0 999px 999px 0;color:#9fe0b5}
.vb button:focus-visible{outline:2px solid #8fb0ff}
`;

function ensureCss() {
    if (document.getElementById("encl-panel-css")) return;
    const st = document.createElement("style");
    st.id = "encl-panel-css";
    st.textContent = PANEL_CSS + CSS.replaceAll(".encl", ".ep .encl");
    document.head.appendChild(st);
}

/** Phần tử khung nhìn 3D đang hiện, để gắn bảng và thanh chuyển nhìn vào đúng chỗ. */
function viewportHost(): HTMLElement | null {
    const all = Array.from(document.querySelectorAll<HTMLElement>("chili-uiview"));
    const el = all.find((x) => x.offsetParent !== null) ?? all[0] ?? null;
    if (el && getComputedStyle(el).position === "static") el.style.position = "relative";
    return el;
}

let uid = 0;
const newId = () => `${Date.now().toString(36)}${(uid++).toString(36)}`;

const QUICK_HOLES: [string, string][] = [
    ["btn12", "Nút nhấn"],
    ["led5", "Đèn LED"],
    ["dc55", "Jack nguồn"],
    ["usbc", "USB-C"],
    ["kcd1", "Công tắc"],
    ["custom", "Lỗ tròn"],
];

const FACE_NAMES: [string, string][] = [
    ["lid", "Nắp (trên)"],
    ["front", "Mặt trước"],
    ["back", "Mặt sau"],
    ["left", "Bên trái"],
    ["right", "Bên phải"],
    ["bottom", "Đáy"],
];

/** Tìm hộp đang làm việc: hộp chứa khối đang chọn, không thì hộp tạo sau cùng. */
function currentEnclosure(document: IDocument): EnclosureFolder | undefined {
    for (const n of document.selection.getSelectedNodes()) {
        for (let p: INode | undefined = n; p; p = p.parent) if (p instanceof EnclosureFolder) return p;
    }
    const all = findEnclosureFolders(document).filter(
        (x): x is EnclosureFolder => x instanceof EnclosureFolder,
    );
    return all[all.length - 1];
}

class EnclosureEditor {
    static current?: EnclosureEditor;
    private readonly root = el("div", { className: "ep" });
    private readonly listBox = el("div", { style: "display:grid;gap:8px" });
    private readonly blockBox = el("div", { style: "display:grid;gap:8px" });
    private readonly info = el("p", { className: "note" });
    private readonly state: EnclosureParams;
    private readonly body?: ShapeNode;
    private readonly lid?: ShapeNode;
    private readonly origBody?: Result<IShape>;
    private readonly origLid?: Result<IShape>;
    private previewShapes: IShape[] = [];
    private timer?: number;
    private selected?: string;
    private step = 1;
    private last?: ReturnType<typeof buildAll>;
    private prevHandler?: IEventHandler;
    private dragHandler?: IEventHandler;
    private building = false;
    private needFit = false;
    private sizeBox!: HTMLElement;
    private boxDetails!: HTMLDetailsElement;
    private readonly boardsBox = el("div", { className: "chips" });
    private portBox?: HTMLElement;
    private pending = false;

    constructor(
        readonly document: IDocument,
        readonly folder: EnclosureFolder,
        firstHole?: HoleSpec,
    ) {
        EnclosureEditor.current?.cancel();
        EnclosureEditor.current = this;
        const d = folder.data!;
        this.state = { o: d.o, holes: d.holes, blocks: d.blocks ?? [] };
        const parts = printableIn(folder);
        this.body = parts.find((x) => !isLid(x.name));
        this.lid = parts.find((x) => isLid(x.name));
        this.origBody = this.body?.shape;
        this.origLid = this.lid?.shape;
        if (firstHole) {
            this.state.holes.push(firstHole);
            this.selected = firstHole.id;
        }
        ensureCss();
        this.render();
        this.renderBoardChips();
        window.document.body.appendChild(this.root);
        this.place();
        window.addEventListener("resize", this.place);
        this.prevHandler = document.visual.eventHandler;
        this.dragHandler = new EnclosureDragHandler(this);
        document.visual.eventHandler = this.dragHandler;
        this.renderLists();
        if (firstHole) this.preview();
        else this.updateInfo();
    }

    private render() {
        const close = el("button", { type: "button", textContent: "✕", title: "Huỷ thay đổi" });
        close.addEventListener("click", () => this.cancel());
        const addRow = el("div", { className: "adds" });
        for (const [k, label] of QUICK_HOLES) {
            const b = el("button", { type: "button", textContent: `+ ${label}` });
            b.addEventListener("click", () => this.addHole(k));
            addRow.append(b);
        }
        const blockRow = el("div", { className: "adds" });
        for (const [t, label] of [
            ["hollow", "Hộp nhỏ"],
            ["solid", "Khối đặc"],
            ["cyl", "Trụ tròn"],
        ] as const) {
            const b = el("button", { type: "button", textContent: `+ ${label}` });
            b.addEventListener("click", () => this.addBlock(t));
            blockRow.append(b);
        }
        this.boxDetails = el("details", {});
        this.renderScreens();
        this.refreshBoxForm();
        const boxDetails = this.boxDetails;
        this.sizeBox = el("div", { style: "display:grid;gap:6px" });
        this.renderSize();

        const apply = el("button", { type: "button", className: "pri", textContent: "Xong" });
        apply.addEventListener("click", () => this.apply());
        const cancel = el("button", { type: "button", textContent: "Huỷ" });
        cancel.addEventListener("click", () => this.cancel());

        this.root.append(
            el("header", {}, el("b", { textContent: "Làm hộp" }), close),
            el(
                "div",
                { className: "body" },
                el("h5", { textContent: "Thêm module — bấm là có, hộp tự nới" }),
                this.palette(),
                this.boardsBox,
                el("h5", { textContent: "Màn hình gắn dưới nắp — bấm để chọn" }),
                this.screenBox,
                el("h5", { textContent: "Chân bắt bo mạch (vít / ren)" }),
                this.screwPicker(),
                el("h5", { textContent: "Kích thước hộp" }),
                this.sizeBox,
                el("h5", { textContent: "Cổng tự khoét ở thành trái" }),
                (this.portBox = el("div", {}, ...(this.portToggles() ? [this.portToggles()!] : []))),
                el("h5", { textContent: "Thêm lỗ khoét" }),
                addRow,
                this.listBox,
                el("h5", { textContent: "Thêm khối trên nắp" }),
                blockRow,
                this.blockBox,
                boxDetails,
                this.info,
            ),
            el("footer", {}, cancel, apply),
        );
    }

    /** Đặt bảng ở cột bên phải (chỗ khung Trợ lý AI), cao bằng khung 3D, không che hình. */
    private readonly place = () => {
        const host = viewportHost()?.getBoundingClientRect();
        const top = host ? host.top : 140;
        const bottom = host ? window.innerHeight - host.bottom : 26;
        const right = host ? Math.max(0, window.innerWidth - host.right) : 0;
        const width = right >= 280 ? right : 340;
        Object.assign(this.root.style, {
            top: `${top}px`,
            bottom: `${bottom}px`,
            right: "0px",
            width: `${width}px`,
        });
    };

    /** Danh sách module theo nhóm, bấm để thêm vào hộp. */
    private palette(): HTMLElement {
        const groups = new Map<string, [string, BoardPreset][]>();
        for (const [k, p] of Object.entries(BOARD_PRESETS)) {
            const g = p.group ?? "Khác";
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g)!.push([k, p]);
        }
        const root = el("div", { style: "display:grid;gap:8px" });
        for (const [g, items] of groups) {
            const chips = el("div", { className: "chips" });
            for (const [k, p] of items) {
                const b = el("button", {
                    type: "button",
                    className: "chip",
                    textContent: `+ ${p.name}`,
                    title: `${p.l} × ${p.w} mm`,
                });
                b.addEventListener("click", () => this.addBoard(k));
                chips.append(b);
            }
            root.append(
                el(
                    "details",
                    { open: g === "Vi điều khiển" || g === "Truyền thông" },
                    el("summary", { textContent: g }),
                    chips,
                ),
            );
        }
        return root;
    }

    private readonly screenBox = el("div", { style: "display:grid;gap:8px" });

    /** Thư viện màn hình theo nhóm; bấm để chọn, bấm lại (hoặc ✕) để bỏ. */
    private renderScreens() {
        const o = this.state.o;
        const groups = new Map<string, [string, ScreenPreset][]>();
        for (const [k, p] of Object.entries(SCREEN_PRESETS)) {
            if (!p) continue;
            const g = p.group ?? "Khác";
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g)!.push([k, p]);
        }
        const pick = (key: string) => {
            o.screen = o.screen === key ? "none" : key;
            this.growToFit();
            this.renderScreens();
            this.boardsChanged();
        };
        const cur = SCREEN_PRESETS[o.screen];
        const head = cur
            ? el("span", { className: "chip on" }, `Đang dùng: ${cur.name}`)
            : el("div", { className: "info", textContent: "Chưa chọn màn hình." });
        if (cur) {
            const x = el("button", { type: "button", textContent: "✕", title: "Bỏ màn hình" });
            x.addEventListener("click", () => pick(o.screen));
            head.append(x);
        }
        const blocks: HTMLElement[] = [];
        for (const [g, items] of groups) {
            const chips = el("div", { className: "chips" });
            for (const [k, p] of items) {
                const b = el("button", {
                    type: "button",
                    className: k === o.screen ? "chip on" : "chip",
                    textContent: p.name,
                    title: `Bo ${p.w} × ${p.h} mm · ô khoét ${p.win[0]} × ${p.win[1]} mm${p.holes ? ` · lỗ vít cách ${p.holes[0]} × ${p.holes[1]} mm` : " · không có lỗ vít, có gờ chặn góc để dán"}`,
                });
                b.addEventListener("click", () => pick(k));
                chips.append(b);
            }
            blocks.push(
                el("details", { open: !!cur && cur.group === g }, el("summary", { textContent: g }), chips),
            );
        }
        this.screenBox.replaceChildren(head, ...blocks);
    }

    /** Chọn kiểu bắt vít bo mạch + vít nắp. */
    private screwPicker(): HTMLElement {
        const o = this.state.o;
        const help = el("div", { className: "info" });
        const explain = () => {
            const s = screwOf(o);
            help.textContent = {
                tap: "Vít tự ren vặn thẳng vào cọc nhựa. Rẻ, nhanh, nhưng tháo lắp nhiều lần sẽ lờn.",
                insert: "Đai ốc đồng cấy nhiệt: dùng mỏ hàn ~220°C ấn đai ốc vào lỗ trên cọc. Có ren thật, tháo lắp thoải mái.",
                nut: "Đai ốc lục giác nhét vào hốc dưới đáy hộp, vít xuyên từ trên bo xuống. Chắc, không cần mỏ hàn.",
                brass: "Trụ đồng lục giác: vít từ dưới đáy lên giữ trụ, bo bắt lên đầu trụ. Mua trụ dài bằng ô “Cọc đỡ”.",
            }[s.kind];
        };
        explain();
        const pick = select(
            "Vít bắt bo",
            o.screw ?? "m3",
            Object.entries(SCREW_PILOT).map(([k, v]) => [k, v.name]),
            (v) => {
                o.screw = v;
                explain();
                this.refreshBoxForm();
                this.preview();
            },
        );
        const lid = check("Vít nắp dùng đai ốc cấy nhiệt M3 (lỗ Ø4.0)", !!o.lidInsert, (v) => {
            o.lidInsert = v;
            this.refreshBoxForm();
            this.preview();
        });
        const scr = check("Cọc bắt màn hình / đầu đọc thẻ trên nắp dùng đai ốc cấy nhiệt (có ren)", !!o.screenInsert, (v) => {
            o.screenInsert = v;
            this.refreshBoxForm();
            this.preview();
        });
        return el("div", { style: "display:grid;gap:6px" }, pick, help, lid, scr);
    }

    /** Đang tự nhập kích thước mà hộp nhỏ hơn bo / màn hình thì tự nới ra cho vừa. */
    private growToFit() {
        const o = this.state.o;
        if (!o.manual) return;
        const lay = layoutEnclosure(o);
        const grew = lay.needL > o.manL || lay.needW > o.manW || lay.hMin > o.manH;
        o.manL = Math.max(o.manL, lay.needL);
        o.manW = Math.max(o.manW, lay.needW);
        o.manH = Math.max(o.manH, lay.hMin);
        if (grew) PubSub.default.pub("showToast", "toast.message{0}" as any, "Hộp đã tự nới ra cho vừa.");
    }

    /** Thêm module; nếu đang tự nhập kích thước mà hộp nhỏ hơn thì tự nới ra cho vừa. */
    private addBoard(key: string) {
        const p = BOARD_PRESETS[key];
        if (!p) return;
        const o = this.state.o;
        o.boards.push({ preset: key, l: p.l, w: p.w, pillar: p.pillar, comp: p.comp, stack: false });
        if (o.manual) {
            const lay = layoutEnclosure(o);
            const grew = lay.needL > o.manL || lay.needW > o.manW || lay.hMin > o.manH;
            o.manL = Math.max(o.manL, lay.needL);
            o.manW = Math.max(o.manW, lay.needW);
            o.manH = Math.max(o.manH, lay.hMin);
            if (grew)
                PubSub.default.pub(
                    "showToast",
                    "toast.message{0}" as any,
                    "Hộp đã tự nới ra cho vừa module mới.",
                );
        }
        this.boardsChanged();
    }

    private boardsChanged() {
        this.needFit = true;
        this.renderBoardChips();
        this.renderSize();
        this.refreshBoxForm();
        const fresh = this.portToggles();
        if (this.portBox) this.portBox.replaceChildren(...(fresh ? [fresh] : []));
        this.preview();
    }

    /** Các module đang có trong hộp, bấm ✕ để bỏ. */
    private renderBoardChips() {
        this.boardsBox.replaceChildren(
            ...this.state.o.boards.map((b, i) => {
                const c = el("span", { className: "chip on" }, BOARD_PRESETS[b.preset]?.name ?? b.preset);
                const x = el("button", { type: "button", textContent: "✕", title: "Bỏ module này" });
                x.addEventListener("click", () => {
                    this.state.o.boards.splice(i, 1);
                    this.boardsChanged();
                });
                c.append(x);
                return c;
            }),
        );
    }

    private refreshBoxForm() {
        const boxForm = buildForm(this.state.o, false);
        boxForm.addEventListener("input", () => this.preview());
        boxForm.addEventListener("change", () => {
            this.renderScreens();
            this.preview();
        });
        boxForm.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).tagName === "BUTTON") {
                this.renderBoardChips();
                this.preview();
            }
        });
        this.boxDetails.replaceChildren(
            el("summary", { textContent: "Chi tiết bo mạch, màn hình, đầu đọc thẻ" }),
            boxForm,
        );
    }

    /** Bật / tắt từng cổng tự khoét (USB, RJ45, DB9) của các bo. */
    private portToggles(): HTMLElement | undefined {
        const rows = this.state.o.boards.flatMap((b) =>
            allPortsOf(b).map((port) =>
                check(
                    `${port.name} — ${BOARD_PRESETS[b.preset]?.name ?? b.preset}`,
                    !b.portsOff?.includes(port.name),
                    (v) => {
                        const off = new Set(b.portsOff ?? []);
                        if (v) off.delete(port.name);
                        else off.add(port.name);
                        b.portsOff = [...off];
                        this.preview();
                    },
                ),
            ),
        );
        return rows.length ? el("div", { style: "display:grid;gap:4px" }, ...rows) : undefined;
    }

    /** Ô kích thước hộp: tự tính theo bo, hoặc tự gõ dài × rộng × cao (trong lòng hộp). */
    private renderSize() {
        const o = this.state.o;
        const lay = layoutEnclosure(o);
        const auto = el("input", { type: "checkbox", checked: !o.manual });
        auto.addEventListener("change", () => {
            o.manual = !auto.checked;
            if (o.manual) {
                o.manL = lay.L;
                o.manW = lay.W;
                o.manH = lay.H;
            }
            this.renderSize();
            this.preview();
        });
        const num = (label: string, key: "manL" | "manW" | "manH", value: number) => {
            const f = numInput(
                label,
                round(value),
                (v) => {
                    o[key] = v;
                    this.preview();
                },
                1,
            );
            (f.querySelector("input") as HTMLInputElement).disabled = !o.manual;
            return f;
        };
        const warn: string[] = [];
        if (o.manual) {
            if (lay.L < lay.needL) warn.push(`dài nên ≥ ${lay.needL}`);
            if (lay.W < lay.needW) warn.push(`rộng nên ≥ ${lay.needW}`);
            if (lay.H < lay.hMin) warn.push(`cao nên ≥ ${lay.hMin}`);
        }
        this.sizeBox.replaceChildren(
            el("label", { className: "chk" }, auto, "Tự tính vừa với bo mạch"),
            el(
                "div",
                { className: "row", style: "grid-template-columns:repeat(3,minmax(0,1fr))" },
                num("Dài (mm)", "manL", o.manual ? o.manL : lay.L),
                num("Rộng (mm)", "manW", o.manual ? o.manW : lay.W),
                num("Cao (mm)", "manH", o.manual ? o.manH : lay.H),
            ),
            el("p", {
                className: warn.length ? "note warn" : "note",
                textContent: warn.length
                    ? `Hộp nhỏ hơn linh kiện: ${warn.join(", ")} mm`
                    : "Kích thước trong lòng hộp, chưa tính độ dày thành. Bỏ tick để tự gõ.",
            }),
        );
    }

    private stepButtons() {
        const box = el("div", { className: "steps" }, el("span", { className: "note", textContent: "Bước" }));
        for (const v of [0.5, 1, 5, 10]) {
            const b = el("button", {
                type: "button",
                textContent: `${v}`,
                className: v === this.step ? "on" : "",
            });
            b.addEventListener("click", () => {
                this.step = v;
                this.renderLists();
            });
            box.append(b);
        }
        return box;
    }

    private pad(onMove: (dx: number, dy: number) => void) {
        const pad = el("div", { className: "pad" });
        const cells: [string, number, number, string][] = [
            ["", 0, 0, ""],
            ["▲", 0, 1, "Lên / ra sau"],
            ["", 0, 0, ""],
            ["◀", -1, 0, "Sang trái"],
            ["●", 0, 0, "Về giữa"],
            ["▶", 1, 0, "Sang phải"],
            ["", 0, 0, ""],
            ["▼", 0, -1, "Xuống / ra trước"],
            ["", 0, 0, ""],
        ];
        for (const [t, dx, dy, tip] of cells) {
            if (!t) {
                pad.append(el("span"));
                continue;
            }
            const b = el("button", { type: "button", textContent: t, title: tip });
            b.addEventListener("click", () => (t === "●" ? onMove(Number.NaN, Number.NaN) : onMove(dx, dy)));
            pad.append(b);
        }
        return pad;
    }

    private renderLists() {
        this.listBox.replaceChildren(
            ...this.state.holes.map((h, i) => {
                const card = el("div", { className: `card${h.id === this.selected ? " on" : ""}` });
                card.addEventListener("pointerdown", () => {
                    if (this.selected !== h.id) {
                        this.selected = h.id;
                        for (const c of Array.from(this.listBox.children)) c.classList.remove("on");
                        card.classList.add("on");
                    }
                });
                const del = el("button", { type: "button", textContent: "Xoá" });
                del.addEventListener("click", () => {
                    this.state.holes.splice(i, 1);
                    this.renderLists();
                    this.preview();
                });
                const p = HOLE_PRESETS[h.preset];
                const title = `${i + 1}. ${p && h.preset !== "custom" ? p.name : h.shape === "circle" ? "Lỗ tròn" : "Lỗ chữ nhật"}`;
                const num = (label: string, key: "x" | "y" | "w" | "h" | "count" | "pitch", step = 0.5) =>
                    numInput(
                        label,
                        h[key],
                        (v) => {
                            (h as any)[key] = key === "count" ? Math.max(1, Math.round(v)) : v;
                            this.preview();
                        },
                        step,
                    );
                const faceSel = select("Mặt", h.face, FACE_NAMES, (v) => {
                    h.face = v as HoleFace;
                    const d = this.defaultPos(h.face);
                    h.x = d.x;
                    h.y = d.y;
                    this.renderLists();
                    this.preview();
                });
                const shapeSel = select(
                    "Dạng",
                    h.shape,
                    [
                        ["circle", "Tròn"],
                        ["rect", "Chữ nhật"],
                    ],
                    (v) => {
                        h.shape = v as HoleSpec["shape"];
                        h.preset = "custom";
                        this.renderLists();
                        this.preview();
                    },
                );
                card.append(
                    el("div", { className: "ch" }, el("span", { textContent: title }), del),
                    el(
                        "div",
                        { className: "row", style: "grid-template-columns:1.4fr 1fr" },
                        faceSel,
                        shapeSel,
                    ),
                    el(
                        "div",
                        { className: "move" },
                        this.pad((dx, dy) => {
                            if (Number.isNaN(dx)) {
                                h.x = 0;
                                if (h.face === "lid" || h.face === "bottom") h.y = 0;
                            } else {
                                h.x = round(h.x + dx * this.step);
                                h.y = round(h.y + dy * this.step);
                            }
                            this.renderLists();
                            this.preview();
                        }),
                        el("div", { style: "display:grid;gap:6px" }, this.stepButtons()),
                    ),
                    el(
                        "div",
                        { className: "row" },
                        num("X (mm)", "x"),
                        num(h.face === "lid" || h.face === "bottom" ? "Y (mm)" : "Cao (mm)", "y"),
                        num(h.shape === "circle" ? "Ø (mm)" : "Rộng", "w", 0.1),
                        h.shape === "rect" ? num("Cao lỗ", "h", 0.1) : el("span"),
                    ),
                    el("div", { className: "row" }, num("Số lỗ", "count", 1), num("Cách (mm)", "pitch")),
                );
                return card;
            }),
        );
        this.blockBox.replaceChildren(
            ...this.state.blocks.map((k, i) => {
                const card = el("div", { className: "card" });
                const del = el("button", { type: "button", textContent: "Xoá" });
                del.addEventListener("click", () => {
                    this.state.blocks.splice(i, 1);
                    this.renderLists();
                    this.preview();
                });
                const names = { hollow: "Hộp nhỏ rỗng", solid: "Khối đặc", cyl: "Trụ tròn" };
                const num = (label: string, key: "x" | "y" | "w" | "d" | "h") =>
                    numInput(label, k[key], (v) => {
                        k[key] = v;
                        this.preview();
                    });
                card.append(
                    el(
                        "div",
                        { className: "ch" },
                        el("span", { textContent: `${i + 1}. ${names[k.type]}` }),
                        del,
                    ),
                    el(
                        "div",
                        { className: "move" },
                        this.pad((dx, dy) => {
                            if (Number.isNaN(dx)) {
                                k.x = 0;
                                k.y = 0;
                            } else {
                                k.x = round(k.x + dx * this.step);
                                k.y = round(k.y + dy * this.step);
                            }
                            this.renderLists();
                            this.preview();
                        }),
                        el("div", { style: "display:grid;gap:6px" }, this.stepButtons()),
                    ),
                    el(
                        "div",
                        { className: "row" },
                        num("X", "x"),
                        num("Y", "y"),
                        num(k.type === "cyl" ? "Ø" : "Dài", "w"),
                        k.type === "cyl" ? el("span") : num("Rộng", "d"),
                    ),
                    el(
                        "div",
                        { className: "row", style: "grid-template-columns:1fr 3fr" },
                        num("Cao", "h"),
                        k.type === "hollow"
                            ? check("Thông xuống hộp lớn (luồn dây)", k.thru, (v) => {
                                  k.thru = v;
                                  this.preview();
                              })
                            : el("span"),
                    ),
                );
                return card;
            }),
        );
    }

    private defaultPos(face: HoleFace): { x: number; y: number } {
        if (face === "lid" || face === "bottom") return { x: 0, y: 0 };
        const lay = layoutEnclosure(this.state.o);
        return { x: 0, y: round(this.state.o.wall + lay.H / 2) };
    }

    private addHole(preset: string) {
        const p = HOLE_PRESETS[preset] ?? { name: "Lỗ", shape: "circle" as const, w: 6, h: 6 };
        const face: HoleFace =
            preset === "usbc" || preset === "dc55" ? "left" : preset === "kcd1" ? "right" : "front";
        const pos = this.defaultPos(face);
        const h: HoleSpec = {
            id: newId(),
            face,
            preset,
            shape: p.shape,
            w: p.w,
            h: p.h,
            x: pos.x,
            y: pos.y,
            count: 1,
            pitch: 20,
        };
        this.state.holes.push(h);
        this.selected = h.id;
        this.renderLists();
        this.preview();
        this.listBox.lastElementChild?.scrollIntoView({ block: "nearest" });
    }

    private addBlock(type: BlockSpec["type"]) {
        this.state.blocks.push({ id: newId(), type, x: 0, y: 0, w: 24, d: 20, h: 12, thru: true });
        this.renderLists();
        this.preview();
        this.blockBox.lastElementChild?.scrollIntoView({ block: "nearest" });
    }

    private updateInfo(err?: string) {
        const lay = layoutEnclosure(this.state.o);
        const t = this.state.o.wall;
        const edited = [this.body, this.lid].some((n) => n && !(n instanceof EditableShapeNode));
        this.info.replaceChildren(
            `Hộp ngoài ${(lay.L + 2 * t).toFixed(1)} × ${(lay.W + 2 * t).toFixed(1)} × ${(lay.H + 2 * t).toFixed(1)} mm · ${this.state.holes.length} lỗ · ${this.state.blocks.length} khối. Giữ chuột trái vào lỗ hoặc khối rồi kéo để dời. Hoặc nhìn từ ngoài vào mặt đó: ◀ ▶ là trái phải, ▲ ▼ là lên xuống (trên nắp là ra sau / ra trước).`,
            ...(edited
                ? [
                      el("div", {
                          className: "warn",
                          textContent:
                              "Thân hoặc nắp đã được sửa bằng công cụ khác; bấm Xong sẽ vẽ lại theo bảng này.",
                      }),
                  ]
                : []),
            ...(err ? [el("div", { className: "warn", textContent: `Chưa vẽ được: ${err}` })] : []),
        );
    }

    /** Vẽ lại ngay khi đang kéo, tối đa vài lần mỗi giây. */
    previewLive() {
        if (this.building) {
            this.pending = true;
            return;
        }
        this.building = true;
        window.setTimeout(() => {
            this.rebuildNow();
            this.building = false;
            if (this.pending) {
                this.pending = false;
                this.previewLive();
            }
        }, 30);
    }

    private rebuildNow() {
        try {
            const r = buildAll(this.state.o, this.state.holes, this.state.blocks);
            const old = this.previewShapes;
            if (this.body) this.body.shape = Result.ok(r.body);
            if (this.lid) this.lid.shape = Result.ok(r.lid);
            this.previewShapes = [r.body, r.lid];
            r.parts.forEach((p) => p.shape.dispose());
            old.forEach((x) => x.dispose());
            this.last = r;
            this.document.visual.update();
        } catch (e) {
            this.updateInfo(String((e as Error).message ?? e));
        }
    }

    // ---- kéo lỗ / khối bằng chuột
    /** Toạ độ thế giới của từng lỗ, khối, kèm mặt phẳng để kéo trên đó. */
    handles(): DragHandle[] {
        const lay = layoutEnclosure(this.state.o);
        const t = this.state.o.wall;
        const Lo = lay.L + 2 * t;
        const Wo = lay.W + 2 * t;
        const lidTop = lay.H + 2 * t;
        const lidVisible = this.lid?.visible !== false;
        const bodyVisible = this.body?.visible !== false;
        const out: DragHandle[] = [];
        const P = (o: XYZ, n: XYZ, x: XYZ) => new Plane({ origin: o, normal: n, xvec: x });
        for (const h of this.state.holes) {
            if (h.face === "lid" ? !lidVisible : !bodyVisible) continue;
            const r = h.w / 2;
            for (let i = 0; i < h.count; i++) {
                const du = (i - (h.count - 1) / 2) * h.pitch;
                const u = h.x + du;
                const v = h.y;
                let world: XYZ;
                let plane: Plane;
                let toXY: (p: XYZ) => { x: number; y: number };
                switch (h.face) {
                    case "lid":
                        world = new XYZ(u, v, lidTop);
                        plane = P(world, XYZ.unitZ, XYZ.unitX);
                        toXY = (p) => ({ x: p.x - du, y: p.y });
                        break;
                    case "bottom":
                        world = new XYZ(u, v, 0);
                        plane = P(world, XYZ.unitZ, XYZ.unitX);
                        toXY = (p) => ({ x: p.x - du, y: p.y });
                        break;
                    case "front":
                        world = new XYZ(u, -Wo / 2, v);
                        plane = P(world, XYZ.unitY, XYZ.unitX);
                        toXY = (p) => ({ x: p.x - du, y: p.z });
                        break;
                    case "back":
                        world = new XYZ(-u, Wo / 2, v);
                        plane = P(world, XYZ.unitY, XYZ.unitX);
                        toXY = (p) => ({ x: -p.x - du, y: p.z });
                        break;
                    case "left":
                        world = new XYZ(-Lo / 2, -u, v);
                        plane = P(world, XYZ.unitX, XYZ.unitY);
                        toXY = (p) => ({ x: -p.y - du, y: p.z });
                        break;
                    default:
                        world = new XYZ(Lo / 2, u, v);
                        plane = P(world, XYZ.unitX, XYZ.unitY);
                        toXY = (p) => ({ x: p.y - du, y: p.z });
                }
                out.push({
                    id: h.id,
                    world,
                    plane,
                    radius: Math.max(r, h.shape === "rect" ? h.h / 2 : r),
                    toXY,
                    set: (x, y) => ((h.x = x), (h.y = y)),
                    get: () => ({ x: h.x, y: h.y }),
                });
            }
        }
        if (lidVisible)
            for (const k of this.state.blocks) {
                const world = new XYZ(k.x, k.y, lidTop + k.h);
                out.push({
                    id: k.id,
                    world,
                    plane: P(world, XYZ.unitZ, XYZ.unitX),
                    radius: Math.max(k.w, k.type === "cyl" ? k.w : k.d) / 2,
                    toXY: (p) => ({ x: p.x, y: p.y }),
                    set: (x, y) => ((k.x = x), (k.y = y)),
                    get: () => ({ x: k.x, y: k.y }),
                });
            }
        return out;
    }

    selectItem(id: string) {
        if (this.selected === id) return;
        this.selected = id;
        this.renderLists();
        this.listBox.querySelector(".card.on")?.scrollIntoView({ block: "nearest" });
    }

    afterDrag() {
        this.renderLists();
        this.preview();
    }

    /** Vẽ lại thân + nắp ngay trên hình (chưa ghi vào lịch sử hoàn tác). */
    preview() {
        if (this.timer) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
            try {
                const r = buildAll(this.state.o, this.state.holes, this.state.blocks);
                const old = this.previewShapes;
                if (this.body) this.body.shape = Result.ok(r.body);
                if (this.lid) this.lid.shape = Result.ok(r.lid);
                this.previewShapes = [r.body, r.lid];
                r.parts.forEach((p) => p.shape.dispose());
                old.forEach((x) => x.dispose());
                this.last = r;
                this.document.visual.update();
                if (this.needFit) {
                    this.needFit = false;
                    this.document.application.activeView?.cameraController.fitContent();
                }
                this.updateInfo();
            } catch (e) {
                this.updateInfo(String((e as Error).message ?? e));
            }
        }, 180);
    }

    private restore() {
        if (this.timer) window.clearTimeout(this.timer);
        if (this.body && this.origBody) this.body.shape = this.origBody;
        if (this.lid && this.origLid) this.lid.shape = this.origLid;
        this.previewShapes.forEach((x) => x.dispose());
        this.previewShapes = [];
    }

    private close() {
        window.removeEventListener("resize", this.place);
        if (this.document.visual.eventHandler === this.dragHandler) {
            this.document.visual.eventHandler = this.document.visual.defaultEventHandler;
        }
        this.root.remove();
        if (EnclosureEditor.current === this) EnclosureEditor.current = undefined;
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(this.state.o));
        } catch {}
    }

    cancel() {
        this.restore();
        this.document.visual.update();
        this.close();
    }

    apply() {
        let r: ReturnType<typeof buildAll>;
        try {
            r = buildAll(this.state.o, this.state.holes, this.state.blocks);
        } catch (e) {
            this.updateInfo(String((e as Error).message ?? e));
            return;
        }
        this.restore();
        commitEnclosure(this.document, this.folder, this.state, r);
        this.close();
        PubSub.default.pub(
            "showToast",
            "toast.message{0}" as any,
            "Đã lưu hộp. Bấm Ctrl+Z nếu muốn quay lại.",
        );
    }
}

/** Ghi hộp đã vẽ lại vào bản vẽ (một bước hoàn tác): thay thân, nắp, linh kiện tham khảo, lưu thông số. */
function commitEnclosure(
    document: IDocument,
    folder: EnclosureFolder,
    state: EnclosureParams,
    r: ReturnType<typeof buildAll>,
) {
    const nodes = printableIn(folder);
    const body = nodes.find((x) => !isLid(x.name));
    const lid = nodes.find((x) => isLid(x.name));
    Transaction.execute(document, "edit enclosure", () => {
        folder.params = JSON.stringify(state);
        folder.name = enclosureName(r.outer);
        const swap = (old: ShapeNode | undefined, name: string, shape: IShape) => {
            const n = new EditableShapeNode({ document, name, shape });
            if (old) {
                n.visible = old.visible;
                folder.insertAfter(old, n);
                folder.remove(old);
            } else folder.add(n);
        };
        swap(body, "Thân hộp", r.body);
        swap(lid, "Nắp hộp", r.lid);
        let partsVisible = true;
        for (let c = folder.firstChild; c; c = c.nextSibling) {
            if (c instanceof FolderNode && c.name.startsWith("Linh kiện")) {
                partsVisible = c.visible;
                folder.remove(c);
                break;
            }
        }
        if (r.parts.length) {
            const pf = new FolderNode({ document, name: "Linh kiện tham khảo (không in)" });
            pf.visible = partsVisible;
            folder.add(pf);
            addParts(document, pf, r.parts);
        }
    });
    document.visual.update();
}

function openEditor(application: IApplication, addPreset?: string): boolean {
    const document = application.activeView?.document;
    if (!document) {
        PubSub.default.pub("showToast", "toast.document.noActivated");
        return false;
    }
    const folder = currentEnclosure(document);
    if (!folder?.data) {
        PubSub.default.pub(
            "showToast",
            "toast.message{0}" as any,
            "Chưa có hộp nào sửa được. Bấm “Tạo hộp bo mạch” trước.",
        );
        return false;
    }
    let first: HoleSpec | undefined;
    if (addPreset) {
        const p = HOLE_PRESETS[addPreset] ?? HOLE_PRESETS["btn12"];
        first = {
            id: newId(),
            face: "front",
            preset: addPreset,
            shape: p.shape,
            w: p.w,
            h: p.h,
            x: 0,
            y: 15,
            count: 1,
            pitch: 20,
        };
    }
    new EnclosureEditor(document, folder, first);
    return true;
}

@command({
    key: "enclosure.edit" as any,
    icon: "icon-edit",
})
export class EditEnclosureCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        openEditor(application);
    }
}

// ------------------------------------------------------------------ thanh chuyển nhìn: Cả hộp / Chỉ nắp / Chỉ đáy
type ViewMode = "all" | "lid" | "body";

function setViewMode(document: IDocument, folder: FolderNode, mode: ViewMode) {
    for (let c = folder.firstChild; c; c = c.nextSibling) {
        if (c instanceof ShapeNode) c.visible = mode === "all" || (mode === "lid") === isLid(c.name);
        else if (c instanceof FolderNode) {
            for (let p = c.firstChild; p; p = p.nextSibling) {
                const onLid = LID_PART_NAMES.has(p.name);
                p.visible = mode === "all" || (mode === "lid") === onLid;
            }
        }
    }
    document.selection.clearSelection();
    document.visual.update();
}

function currentMode(folder: FolderNode): ViewMode {
    const nodes = printableIn(folder);
    const lid = nodes.find((x) => isLid(x.name));
    const body = nodes.find((x) => !isLid(x.name));
    if (lid?.visible && body?.visible) return "all";
    if (lid?.visible) return "lid";
    return "body";
}

let viewBar: HTMLElement | undefined;
function syncViewBar() {
    try {
        const doc = (globalThis as any).app?.activeView?.document as IDocument | undefined;
        const folders = doc ? findEnclosureFolders(doc) : [];
        const folder = folders[folders.length - 1];
        const host = folder ? viewportHost() : null;
        if (!folder || !host || !doc) {
            viewBar?.remove();
            return;
        }
        ensureCss();
        if (!viewBar) viewBar = el("div", { className: "vb" });
        if (viewBar.parentElement !== host) host.appendChild(viewBar);
        const mode = currentMode(folder);
        let partsFolder: FolderNode | undefined;
        for (let c = folder.firstChild; c; c = c.nextSibling)
            if (c instanceof FolderNode && c.name.startsWith("Linh kiện")) partsFolder = c;
        const partsOn = partsFolder?.visible ?? false;
        const key = `${folder.id}:${mode}:${partsFolder ? (partsOn ? 1 : 0) : "-"}`;
        if (viewBar.dataset["key"] === key) return;
        viewBar.dataset["key"] = key;
        viewBar.replaceChildren(
            ...(
                [
                    ["all", "Cả hộp"],
                    ["lid", "Chỉ nắp"],
                    ["body", "Chỉ đáy"],
                ] as [ViewMode, string][]
            ).map(([m, label]) => {
                const b = el("button", {
                    type: "button",
                    textContent: label,
                    className: m === mode ? "on" : "",
                });
                b.addEventListener("click", () => {
                    setViewMode(doc, folder, m);
                    syncViewBar();
                });
                return b;
            }),
        );
        if (partsFolder) {
            const pf = partsFolder;
            const t = el("button", {
                type: "button",
                className: "sep",
                textContent: partsOn ? "Ẩn linh kiện" : "Hiện linh kiện",
                title: "Bo mạch, linh kiện màu xanh trong suốt chỉ để xem, không in ra",
            });
            t.addEventListener("click", () => {
                pf.visible = !pf.visible;
                doc.visual.update();
                syncViewBar();
            });
            viewBar.append(t);
        }
    } catch {}
}
if (typeof window !== "undefined") window.setInterval(syncViewBar, 700);

// ------------------------------------------------------------------ kéo lỗ bằng chuột
interface DragHandle {
    id: string;
    world: XYZ;
    plane: Plane;
    radius: number;
    toXY: (p: XYZ) => { x: number; y: number };
    set: (x: number, y: number) => void;
    get: () => { x: number; y: number };
}

/** Khi bảng "Làm hộp" mở: giữ chuột trái vào lỗ / khối rồi kéo để dời; kéo chỗ khác vẫn xoay hộp. */
class EnclosureDragHandler implements IEventHandler {
    isEnabled = true;
    allowLeftRotate = true;
    private drag?: { h: DragHandle; dx: number; dy: number };

    constructor(readonly editor: EnclosureEditor) {}

    dispose() {}

    private hit(view: IView, event: PointerEvent): DragHandle | undefined {
        let best: DragHandle | undefined;
        let bestD = Number.POSITIVE_INFINITY;
        for (const h of this.editor.handles()) {
            const c = view.worldToScreen(h.world);
            const edge = view.worldToScreen(h.world.add(h.plane.xvec.multiply(h.radius)));
            const rpx = Math.hypot(edge.x - c.x, edge.y - c.y);
            const d = Math.hypot(event.offsetX - c.x, event.offsetY - c.y);
            if (d <= Math.max(rpx, 6) + 10 && d < bestD) {
                best = h;
                bestD = d;
            }
        }
        return best;
    }

    pointerDown(view: IView, event: PointerEvent): void {
        this.allowLeftRotate = true;
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        const h = this.hit(view, event);
        if (!h) return;
        const p = h.plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
        if (!p) return;
        const at = h.toXY(p);
        const cur = h.get();
        this.drag = { h, dx: cur.x - at.x, dy: cur.y - at.y };
        this.allowLeftRotate = false;
        this.editor.selectItem(h.id);
    }

    pointerMove(view: IView, event: PointerEvent): void {
        const host = event.target as HTMLElement | null;
        if (this.drag && event.buttons & 1) {
            const p = this.drag.h.plane.intersectRay(view.rayAt(event.offsetX, event.offsetY));
            if (!p) return;
            const at = this.drag.h.toXY(p);
            const snap = (v: number) => Math.round(v * 2) / 2;
            this.drag.h.set(snap(at.x + this.drag.dx), snap(at.y + this.drag.dy));
            this.editor.previewLive();
            if (host) host.style.cursor = "grabbing";
            return;
        }
        if (host && event.buttons === 0) host.style.cursor = this.hit(view, event) ? "grab" : "";
    }

    pointerUp(view: IView, event: PointerEvent): void {
        if (this.drag) {
            this.drag = undefined;
            this.editor.afterDrag();
        }
        this.allowLeftRotate = true;
        const host = event.target as HTMLElement | null;
        if (host) host.style.cursor = "";
    }

    pointerOut(view: IView, event: PointerEvent): void {
        if (this.drag) {
            this.drag = undefined;
            this.editor.afterDrag();
        }
    }

    keyDown(view: IView, event: KeyboardEvent): void {}
}

// ------------------------------------------------------------------ cho trợ lý AI gọi trực tiếp
export interface EnclosureSpec {
    boards: (
        | string
        | { preset?: string; l?: number; w?: number; pillar?: number; comp?: number; stack?: boolean }
    )[];
    screen?: string;
    reader?: string;
    size?: { l?: number; w?: number; h?: number };
    wall?: number;
    holes?: Partial<HoleOptions>[];
    screw?: string;
    lid_insert?: boolean;
    screen_insert?: boolean;
}

function buildOptions(
    spec: Pick<EnclosureSpec, "boards" | "screen" | "reader" | "wall" | "size" | "screw" | "lid_insert" | "screen_insert">,
    unknown: string[] = [],
) {
    const o: EnclosureOptions = structuredClone(DEFAULT_ENCLOSURE);
    o.boards = (spec.boards ?? []).map((b) => {
        const d = typeof b === "string" ? { preset: b } : b;
        const key = d.preset && BOARD_PRESETS[d.preset] ? d.preset : "custom";
        if (d.preset && key === "custom" && d.preset !== "custom") unknown.push(d.preset);
        const p = BOARD_PRESETS[key]!;
        return {
            preset: key,
            l: d.l ?? p.l,
            w: d.w ?? p.w,
            pillar: d.pillar ?? p.pillar,
            comp: d.comp ?? p.comp,
            stack: !!d.stack,
        };
    });
    o.screen = spec.screen && spec.screen in SCREEN_PRESETS ? spec.screen : "none";
    o.reader = spec.reader && spec.reader in READER_PRESETS ? spec.reader : "none";
    if (spec.wall) o.wall = Math.max(1.2, spec.wall);
    if (spec.screw && spec.screw in SCREW_PILOT) o.screw = spec.screw;
    if (spec.lid_insert !== undefined) o.lidInsert = !!spec.lid_insert;
    if (spec.screen_insert !== undefined) o.screenInsert = !!spec.screen_insert;
    if (spec.size && (spec.size.l || spec.size.w || spec.size.h)) {
        const lay = layoutEnclosure(o);
        Object.assign(o, {
            manual: true,
            manL: spec.size.l ?? lay.L,
            manW: spec.size.w ?? lay.W,
            manH: spec.size.h ?? lay.H,
        });
    }
    return o;
}

function holeFromSpec(h: Partial<HoleOptions>): HoleSpec {
    const p = HOLE_PRESETS[h.preset ?? ""] ?? HOLE_PRESETS["custom"]!;
    return {
        id: newId(),
        face: (h.face as HoleFace) ?? "front",
        preset: h.preset && HOLE_PRESETS[h.preset] ? h.preset : "custom",
        shape: h.shape ?? p.shape,
        w: h.w ?? p.w,
        h: h.h ?? p.h,
        x: h.x ?? 0,
        y: h.y ?? (h.face === "lid" || h.face === "bottom" ? 0 : 12),
        count: h.count ?? 1,
        pitch: h.pitch ?? 20,
    };
}

function createFromSpec(spec: EnclosureSpec): string {
    const app = (globalThis as any).app as IApplication | undefined;
    const document = app?.activeView?.document;
    if (!document) throw new Error("Chưa mở bản vẽ nào. Hãy bấm Bản vẽ mới trước.");
    const unknown: string[] = [];
    const o = buildOptions(spec, unknown);
    const holes: HoleSpec[] = (spec.holes ?? []).map(holeFromSpec);
    const r = buildAll(o, holes, []);
    Transaction.execute(document, "create enclosure (AI)", () => {
        const folder = new EnclosureFolder({ document, name: enclosureName(r.outer) });
        folder.params = JSON.stringify({ o, holes, blocks: [] } satisfies EnclosureParams);
        document.modelManager.rootNode.add(folder);
        folder.add(new EditableShapeNode({ document, name: "Thân hộp", shape: r.body }));
        folder.add(new EditableShapeNode({ document, name: "Nắp hộp", shape: r.lid }));
        if (r.parts.length) {
            const pf = new FolderNode({ document, name: "Linh kiện tham khảo (không in)" });
            folder.add(pf);
            addParts(document, pf, r.parts);
        }
    });
    document.visual.update();
    document.application.activeView?.cameraController.fitContent();
    const ports = o.boards.flatMap((b) =>
        portsOf(b).map((p) => `${p.name} của ${BOARD_PRESETS[b.preset]!.name}`),
    );
    return [
        `Đã tạo hộp ${r.outer.map((v) => v.toFixed(1)).join(" × ")} mm (ngoài), ${o.boards.length} bo, ${holes.length} lỗ thêm.`,
        ports.length ? `Đã tự khoét cổng ở thành trái: ${ports.join("; ")}.` : "",
        unknown.length
            ? `Không có sẵn: ${unknown.join(", ")} — đã dùng "Bo khác" với kích thước được đưa.`
            : "",
    ]
        .filter(Boolean)
        .join(" ");
}

export interface EnclosureEditSpec {
    remove_ports?: string[];
    add_ports?: string[];
    add_holes?: Partial<HoleOptions>[];
    remove_holes?: (number | string)[];
    size?: { l?: number; w?: number; h?: number } | "auto";
    boards?: EnclosureSpec["boards"];
    screen?: string;
    reader?: string;
    screw?: string;
    lid_insert?: boolean;
    screen_insert?: boolean;
}

/** Hiểu tên cổng người dùng gọi: "type c", "usb-c", "cổng mạng", "com"... */
function portKey(name: string): string | undefined {
    const n = name.toLowerCase().replace(/[\s_-]+/g, "");
    if (/usb|typec|micro/.test(n)) return "USB";
    if (/rj45|lan|mạng|mang|ethernet/.test(n)) return "RJ45";
    if (/db9|rs232|com|serial/.test(n)) return "DB9";
    return undefined;
}

function editFromSpec(spec: EnclosureEditSpec): string {
    const app = (globalThis as any).app as IApplication | undefined;
    const document = app?.activeView?.document;
    if (!document) throw new Error("Chưa mở bản vẽ nào.");
    const folder = currentEnclosure(document);
    const d = folder?.data;
    if (!folder || !d) throw new Error("Chưa có hộp nào sửa được. Hãy tạo hộp trước (create_pcb_enclosure).");
    EnclosureEditor.current?.cancel();
    const state: EnclosureParams = { o: d.o, holes: d.holes, blocks: d.blocks ?? [] };
    const done: string[] = [];
    if (spec.boards?.length) {
        const fresh = buildOptions({ boards: spec.boards });
        state.o.boards = fresh.boards;
        done.push(`đổi danh sách bo (${fresh.boards.length} bo)`);
    }
    if (spec.screen) state.o.screen = spec.screen in SCREEN_PRESETS ? spec.screen : "none";
    if (spec.reader) state.o.reader = spec.reader in READER_PRESETS ? spec.reader : "none";
    if (spec.screw && spec.screw in SCREW_PILOT) {
        state.o.screw = spec.screw;
        done.push(`chân bắt: ${SCREW_PILOT[spec.screw]!.name}`);
    }
    if (spec.screen_insert !== undefined) {
        state.o.screenInsert = !!spec.screen_insert;
        done.push(spec.screen_insert ? "cọc màn hình dùng đai ốc cấy nhiệt" : "cọc màn hình vít tự ren");
    }
    if (spec.lid_insert !== undefined) {
        state.o.lidInsert = !!spec.lid_insert;
        done.push(spec.lid_insert ? "vít nắp dùng đai ốc cấy nhiệt" : "vít nắp tự ren");
    }
    const togglePorts = (names: string[] | undefined, on: boolean) => {
        for (const raw of names ?? []) {
            const key = portKey(raw);
            if (!key) continue;
            let hit = 0;
            for (const b of state.o.boards) {
                if (!allPortsOf(b).some((p) => p.name === key)) continue;
                const off = new Set(b.portsOff ?? []);
                if (on) off.delete(key);
                else off.add(key);
                b.portsOff = [...off];
                hit++;
            }
            if (hit) done.push(`${on ? "khoét lại" : "bỏ"} cổng ${key}`);
        }
    };
    togglePorts(spec.remove_ports, false);
    togglePorts(spec.add_ports, true);
    if (spec.remove_holes?.length) {
        const before = state.holes.length;
        if (spec.remove_holes.includes("all")) state.holes = [];
        else
            state.holes = state.holes.filter(
                (h, i) => !spec.remove_holes!.some((r) => r === i + 1 || r === h.preset || r === h.face),
            );
        done.push(`xoá ${before - state.holes.length} lỗ`);
    }
    if (spec.add_holes?.length) {
        state.holes.push(...spec.add_holes.map(holeFromSpec));
        done.push(`thêm ${spec.add_holes.length} nhóm lỗ`);
    }
    if (spec.size === "auto") {
        state.o.manual = false;
        done.push("kích thước tự tính");
    } else if (spec.size && (spec.size.l || spec.size.w || spec.size.h)) {
        const lay = layoutEnclosure(state.o);
        Object.assign(state.o, {
            manual: true,
            manL: spec.size.l ?? lay.L,
            manW: spec.size.w ?? lay.W,
            manH: spec.size.h ?? lay.H,
        });
        done.push("đổi kích thước");
    }
    const r = buildAll(state.o, state.holes, state.blocks);
    commitEnclosure(document, folder, state, r);
    const ports = state.o.boards.flatMap((b) => portsOf(b).map((p) => p.name));
    return `Đã sửa hộp: ${done.join(", ") || "không có thay đổi"}. Hộp giờ ${r.outer.map((v) => v.toFixed(1)).join(" × ")} mm, cổng đang khoét: ${ports.join(", ") || "không có"}, ${state.holes.length} nhóm lỗ thêm.`;
}

(globalThis as any).__chiliEnclosure = {
    edit: editFromSpec,
    create: createFromSpec,
    presets: () => ({
        boards: Object.fromEntries(
            Object.entries(BOARD_PRESETS).map(([k, p]) => [
                k,
                `${p.name} ${p.l}×${p.w}mm${p.ports?.length ? `, cổng ${p.ports.map((x) => x.name).join("+")}` : ""}`,
            ]),
        ),
        screens: Object.fromEntries(Object.entries(SCREEN_PRESETS).map(([k, p]) => [k, p?.name ?? "không"])),
        readers: Object.fromEntries(Object.entries(READER_PRESETS).map(([k, p]) => [k, p?.name ?? "không"])),
        holes: Object.fromEntries(Object.entries(HOLE_PRESETS).map(([k, p]) => [k, p.name])),
        screws: Object.fromEntries(Object.entries(SCREW_PILOT).map(([k, p]) => [k, p.name])),
    }),
};

@command({
    key: "enclosure.addModule" as any,
    icon: "icon-plus",
})
export class AddModuleCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        let document = application.activeView?.document;
        if (!document) document = await application.newDocument("Bản vẽ");
        if (!currentEnclosure(document)?.data) {
            // chưa có hộp: tạo hộp trống rồi mở bảng để bấm thêm module
            const o: EnclosureOptions = {
                ...structuredClone(DEFAULT_ENCLOSURE),
                boards: [],
                screen: "none",
                reader: "none",
            };
            const r = buildAll(o, [], []);
            const doc = document;
            Transaction.execute(doc, "create enclosure", () => {
                const folder = new EnclosureFolder({ document: doc, name: enclosureName(r.outer) });
                folder.params = JSON.stringify({ o, holes: [], blocks: [] } satisfies EnclosureParams);
                doc.modelManager.rootNode.add(folder);
                folder.add(new EditableShapeNode({ document: doc, name: "Thân hộp", shape: r.body }));
                folder.add(new EditableShapeNode({ document: doc, name: "Nắp hộp", shape: r.lid }));
            });
            doc.visual.update();
            doc.application.activeView?.cameraController.fitContent();
        }
        openEditor(application);
    }
}
