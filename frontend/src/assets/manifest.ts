/**
 * Asset manifest (CLAUDE.md section 11): asset key -> delivered file + how to show it.
 *
 * - Files are referenced exactly as delivered under 3d_models/ (served at /models/ by
 *   scripts/deliveredModels.ts). Never rename, re-encode or edit them: every correction
 *   (scale, rotation, pivot, part names) lives here.
 * - Ownership and priority copy the workbook 3d_models/EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx,
 *   which stays the source of truth.
 * - The SUMO vType id equals the asset key (ambulance, car_sedan, car_hatchback, truck, bus).
 * - `placeholder.size` is the expected size after fitting (width x, height y, length z, in
 *   metres). The city layout plans with it, so it is right before any model has loaded;
 *   check:assets compares it with the real fitted model.
 */

export type Owner = "Member 1" | "Member 2" | "Member 3" | "Member 4";
export type Priority = "P1" | "P2" | "P3";
export type Size3 = [width: number, height: number, length: number];

export interface AssetEntry {
  /** Path below 3d_models/, exactly as delivered. */
  file: string;
  /** false: render the placeholder without fetching the file. */
  enabled: boolean;
  owner: Owner;
  /** Workbook asset row, or null for a delivered file the workbook does not list. */
  workbook: string | null;
  priority: Priority | null;
  /** Turn the model about +Y first (radians), so it faces +Z; `fit` measures after this. */
  rotationY?: number;
  /** Uniform scale so the model measures `meters` along `axis` (after rotationY). */
  fit?: { axis: "x" | "y" | "z"; meters: number };
  /** Extra uniform scale when the file is already in metres (default 1). */
  scale?: number;
  /** bottom-center: base on y = 0, centred in x/z. none: keep the file's origin. */
  pivot: "bottom-center" | "none";
  /** Applied last, in metres. */
  offset?: [number, number, number];
  placeholder: { size: Size3; color: string; shape: "box" | "cylinder" | "cone" };
  /** Named parts the code drives; missing ones log a warning and use a fallback. */
  requiredParts?: string[];
  optionalParts?: string[];
  /** Part name -> node names in the file (matched case-insensitively, ".001" ignored). */
  aliases?: Record<string, string[]>;
  /** Materials recoloured per instance (car paint), by material name. */
  tintMaterials?: string[];
  /** Nodes not rendered (by name). */
  hide?: string[];
  /** Triangle guideline (CLAUDE.md: ~5k per vehicle, ~20k per building). Advisory only. */
  triBudget: number;
  /** Heavy file: fetched only after the scene is interactive, or on demand. */
  lazy?: boolean;
  /**
   * Draw alpha-blended materials (foliage) as cut-outs: opaque with alphaTest. A render
   * setting on a runtime copy of the material; the file is unchanged.
   */
  alphaCutout?: boolean;
}

const VEHICLE = 5000;
const BUILDING = 20000;
const PROP = 5000;
const HALF_PI = Math.PI / 2;

export const MANIFEST = {
  // ---- emergency vehicles -------------------------------------------------------
  ambulance: {
    file: "Memeber-1/Ambulance by Poly by Google - 8NOFImgkI5N.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Ambulance",
    priority: "P1",
    fit: { axis: "z", meters: 6.0 }, // SUMO vType length
    pivot: "bottom-center",
    placeholder: { size: [2.76, 2.99, 6.0], color: "#f8fafc", shape: "box" },
    requiredParts: ["siren"],
    optionalParts: ["wheel_front_left", "wheel_front_right", "wheel_rear_left", "wheel_rear_right"],
    triBudget: VEHICLE,
  },
  police_car: {
    file: "member-3/police_car.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Police car",
    priority: "P3",
    fit: { axis: "z", meters: 4.6 },
    pivot: "bottom-center",
    placeholder: { size: [2.54, 2.04, 4.6], color: "#1e3a8a", shape: "box" },
    triBudget: VEHICLE,
  },
  fire_truck: {
    file: "member-4/Fire Truck by Ivan Klus - 7iHJ519SwxG.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Fire truck",
    priority: "P3",
    rotationY: HALF_PI, // modelled along X
    fit: { axis: "z", meters: 8.0 },
    pivot: "bottom-center",
    placeholder: { size: [3.04, 3.84, 8.0], color: "#b91c1c", shape: "box" },
    triBudget: VEHICLE,
  },

  // ---- traffic vehicles ---------------------------------------------------------
  car_sedan: {
    file: "member-2/sedan.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Sedan",
    priority: "P1",
    fit: { axis: "z", meters: 4.5 },
    pivot: "bottom-center",
    placeholder: { size: [2.15, 1.38, 4.5], color: "#64748b", shape: "box" },
    tintMaterials: ["White"], // "recolor in code for variety" (workbook)
    triBudget: VEHICLE,
  },
  car_hatchback: {
    file: "member-2/Car Hatchback by Kay Lousberg - BG0KAhmGDt.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Hatchback",
    priority: "P2",
    fit: { axis: "z", meters: 3.9 },
    pivot: "bottom-center",
    placeholder: { size: [2.03, 1.79, 3.9], color: "#0e7490", shape: "box" },
    triBudget: VEHICLE,
  },
  suv: {
    file: "member-3/SUV.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "SUV / van",
    priority: "P2",
    fit: { axis: "z", meters: 4.5 },
    pivot: "bottom-center",
    placeholder: { size: [2.26, 1.63, 4.5], color: "#475569", shape: "box" },
    tintMaterials: ["White.002"],
    triBudget: VEHICLE,
  },
  taxi: {
    file: "member-3/taxi.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Taxi",
    priority: "P3",
    fit: { axis: "z", meters: 4.5 },
    pivot: "bottom-center",
    placeholder: { size: [1.93, 1.4, 4.5], color: "#facc15", shape: "box" },
    triBudget: VEHICLE,
  },
  bus: {
    file: "member-4/Bus by Poly by Google - 4CPpvEmrMoF.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Bus",
    priority: "P2",
    fit: { axis: "z", meters: 12.0 },
    pivot: "bottom-center",
    placeholder: { size: [3.82, 3.72, 12.0], color: "#15803d", shape: "box" },
    triBudget: VEHICLE,
  },
  truck: {
    file: "Memeber-1/Truck by Quaternius - cXw6oiFtZ8.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Truck",
    priority: "P2",
    fit: { axis: "z", meters: 6.5 },
    pivot: "bottom-center",
    placeholder: { size: [3.35, 3.57, 6.5], color: "#a16207", shape: "box" },
    triBudget: VEHICLE,
  },
  auto_rickshaw: {
    file: "Memeber-1/auto_rickshaw.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Auto-rickshaw",
    priority: "P3",
    fit: { axis: "z", meters: 2.8 },
    pivot: "bottom-center",
    placeholder: { size: [1.55, 1.8, 2.8], color: "#16a34a", shape: "box" },
    triBudget: VEHICLE,
  },
  scooter: {
    file: "member-2/Scooter by Poly by Google - eHdEFPwUfCt.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Two-wheeler (bike/scooter)",
    priority: "P3",
    fit: { axis: "z", meters: 1.8 },
    pivot: "bottom-center",
    placeholder: { size: [0.64, 1.24, 1.8], color: "#dc2626", shape: "box" },
    triBudget: VEHICLE,
  },

  // ---- traffic infrastructure ---------------------------------------------------
  traffic_light: {
    file: "member-3/traffic_light.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Traffic light (pole + 3 separate lamps)",
    priority: "P1",
    pivot: "none", // keep the pole on the origin; the head hangs off an arm towards +X
    placeholder: { size: [0.91, 4.05, 0.43], color: "#374151", shape: "box" },
    requiredParts: ["lamp_red", "lamp_yellow", "lamp_green"],
    aliases: {
      lamp_red: ["Red_Light"],
      lamp_yellow: ["Yellow_Light"],
      lamp_green: ["Green_Light"],
    },
    triBudget: PROP,
  },
  pedestrian_signal: {
    file: "member-4/pedestrian_traffic_light.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Pedestrian signal",
    priority: "P3",
    fit: { axis: "y", meters: 3.0 },
    pivot: "bottom-center",
    placeholder: { size: [0.61, 3.0, 0.4], color: "#374151", shape: "cylinder" },
    triBudget: PROP,
  },
  street_tile: {
    file: "member-2/street-tile-c7e3cf.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Stop line / zebra crossing",
    priority: "P2",
    // a plain 8 x 8 m asphalt tile (no stripes): stop lines and zebras are generated in code,
    // as the workbook allows, and the tile paves the depot and hospital ambulance bays
    pivot: "none",
    placeholder: { size: [8, 0.05, 8], color: "#4b5563", shape: "box" },
    triBudget: PROP,
  },
  sign_stop: {
    file: "Memeber-1/Stop sign by Poly by Google - 60GyU9CdZ9r.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Road signs (speed, hospital, no entry)",
    priority: "P3",
    rotationY: -HALF_PI, // the plate's face points along -X in the file
    fit: { axis: "y", meters: 2.4 },
    pivot: "bottom-center",
    placeholder: { size: [0.78, 2.4, 0.08], color: "#dc2626", shape: "box" },
    triBudget: PROP,
  },
  sign_no_parking: {
    file: "Memeber-1/quaternius_cc0-no-parking-sign-1338.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Road signs (speed, hospital, no entry)",
    priority: "P3",
    rotationY: -HALF_PI,
    fit: { axis: "y", meters: 2.4 },
    pivot: "bottom-center",
    placeholder: { size: [0.62, 2.4, 0.12], color: "#2563eb", shape: "box" },
    triBudget: PROP,
  },
  cone: {
    file: "member-3/traffic_cone.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Traffic cones",
    priority: "P2",
    fit: { axis: "y", meters: 0.75 },
    pivot: "bottom-center",
    placeholder: { size: [0.59, 0.75, 0.59], color: "#f97316", shape: "cone" },
    triBudget: PROP,
  },
  barricade: {
    file: "member-4/Traffic Barrier by Zsky - SInF9le9Ch.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Barricade / road-closed barrier",
    priority: "P2",
    fit: { axis: "x", meters: 2.0 },
    pivot: "bottom-center",
    placeholder: { size: [2.0, 1.6, 1.17], color: "#ef4444", shape: "box" },
    triBudget: PROP,
  },
  streetlight: {
    file: "Memeber-1/Streetlight by Kay Lousberg - vPFSLYh6sg.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Streetlight",
    priority: "P2",
    fit: { axis: "y", meters: 7.0 },
    pivot: "none", // keep the pole on the origin; the lamp arm reaches out along -X
    placeholder: { size: [1.96, 7.0, 0.5], color: "#6b7280", shape: "cylinder" },
    triBudget: PROP,
  },
  divider: {
    file: "member-2/divider.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Divider / median",
    priority: "P3",
    rotationY: HALF_PI, // a 1.9 m segment along X in the file; run it along +Z
    pivot: "bottom-center",
    placeholder: { size: [0.66, 0.63, 1.89], color: "#d1d5db", shape: "box" },
    triBudget: PROP,
  },

  // ---- incident and scenario props (placed in Sprint 8) ---------------------------
  wrecked_car: {
    file: "member-2/Crashed wrecked car gltf/Crashed wrecked car.gltf",
    enabled: true,
    owner: "Member 2",
    workbook: "Crashed or wrecked car",
    priority: "P2",
    fit: { axis: "z", meters: 4.5 },
    pivot: "bottom-center",
    placeholder: { size: [2.22, 1.5, 4.5], color: "#57534e", shape: "box" },
    triBudget: VEHICLE,
    lazy: true, // 24.8 MB, mostly 4k textures
  },
  explosion_marker: {
    file: "member-3/explosion_marker.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Explosion/impact marker",
    priority: "P3",
    fit: { axis: "y", meters: 3.0 },
    pivot: "bottom-center",
    placeholder: { size: [2.63, 3.0, 2.91], color: "#f97316", shape: "cone" },
    triBudget: PROP,
  },
  road_block: {
    file: "member-3/road_block_marker.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Road-block marker",
    priority: "P2",
    pivot: "bottom-center",
    placeholder: { size: [1.64, 1.07, 0.9], color: "#f59e0b", shape: "box" },
    triBudget: PROP,
  },

  // ---- buildings and city -------------------------------------------------------
  hospital: {
    file: "member-4/Hospital by Poly by Google - asNvyjkcSG1.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Hospital",
    priority: "P1",
    rotationY: -HALF_PI, // the entrance and "HOSPITAL" sign face +X in the file
    fit: { axis: "x", meters: 64 }, // a 64 m frontage along the road
    pivot: "bottom-center",
    placeholder: { size: [64, 33.7, 34.24], color: "#f1f5f9", shape: "box" },
    triBudget: BUILDING,
  },
  building_01: {
    file: "member-2/Large Building by Kenney - h7Jaq7bqMq.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Generic buildings (3-5 variants)",
    priority: "P1",
    fit: { axis: "y", meters: 26 },
    pivot: "bottom-center",
    placeholder: { size: [24.3, 26, 19.1], color: "#9ca3af", shape: "box" },
    triBudget: BUILDING,
  },
  building_02: {
    file: "member-2/quaternius_cc0-building-747.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Generic buildings (3-5 variants)",
    priority: "P1",
    fit: { axis: "y", meters: 16 },
    pivot: "bottom-center",
    placeholder: { size: [13.5, 16, 11.2], color: "#93c5fd", shape: "box" },
    triBudget: BUILDING,
  },
  building_03: {
    file: "member-2/quaternius_cc0-small-building-746.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Generic buildings (3-5 variants)",
    priority: "P1",
    fit: { axis: "y", meters: 12 },
    pivot: "bottom-center",
    placeholder: { size: [6.45, 12, 9.29], color: "#b45309", shape: "box" },
    triBudget: BUILDING,
  },
  building_04: {
    file: "member-2/Apartment building by Poly by Google - 01lqee-dZAr.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Generic buildings (3-5 variants)",
    priority: "P1",
    pivot: "bottom-center", // already in metres
    placeholder: { size: [10.32, 18.1, 5.79], color: "#d6d3d1", shape: "box" },
    triBudget: BUILDING,
  },
  building_05: {
    file: "Memeber-1/Large Building by Kenney - 3IhrYZp6tP.glb",
    enabled: true,
    owner: "Member 1",
    workbook: null, // delivered by Member 1 outside the workbook list; used as a 5th variant
    priority: null,
    fit: { axis: "y", meters: 20 },
    pivot: "bottom-center",
    placeholder: { size: [11.9, 20, 12.9], color: "#a8a29e", shape: "box" },
    triBudget: BUILDING,
  },
  shops: {
    file: "member-4/model.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Shops / commercial row", // "bazaar-street-and-shrine", mapping confirmed by the team
    priority: "P3",
    pivot: "bottom-center", // already in metres
    placeholder: { size: [28.85, 9.89, 32], color: "#f59e0b", shape: "box" },
    triBudget: BUILDING,
  },
  residential: {
    file: "Memeber-1/Apartment building by Poly by Google - 01lqee-dZAr.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Residential block",
    priority: "P3",
    pivot: "bottom-center",
    placeholder: { size: [10.32, 18.1, 5.79], color: "#e7e5e4", shape: "box" },
    triBudget: BUILDING,
  },
  petrol_station: {
    file: "member-2/Gas Station by Alex Safayan - 7rUkCX-AIR2.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Petrol pump",
    priority: "P3",
    fit: { axis: "x", meters: 22 },
    pivot: "bottom-center",
    placeholder: { size: [22, 7.94, 21.03], color: "#0ea5e9", shape: "box" },
    triBudget: BUILDING,
  },
  fuel_pump: {
    file: "member-2/jerryblessed-fuel-5054.glb",
    enabled: true,
    owner: "Member 2",
    workbook: "Petrol pump",
    priority: "P3",
    pivot: "bottom-center",
    placeholder: { size: [1, 1.76, 0.7], color: "#16a34a", shape: "box" },
    triBudget: PROP,
  },
  flyover: {
    file: "member-3/flyover.glb",
    enabled: true,
    owner: "Member 3",
    workbook: "Flyover / bridge", // "only if your network includes one": the grid has none
    priority: "P3",
    pivot: "bottom-center",
    placeholder: { size: [60, 8, 9.4], color: "#a8a29e", shape: "box" },
    triBudget: BUILDING,
  },
  bus_stop: {
    file: "member-4/standard_bus_stop.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Bus stop",
    priority: "P3",
    pivot: "bottom-center",
    placeholder: { size: [4.84, 2.99, 2.51], color: "#64748b", shape: "box" },
    triBudget: BUILDING,
    lazy: true, // 23.7 MB of textures: load after the scene is interactive
  },

  // ---- environment --------------------------------------------------------------
  tree: {
    file: "member-4/Tree by Quaternius - qZtx0AHhcy.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Trees (2 variants)",
    priority: "P2",
    pivot: "bottom-center",
    placeholder: { size: [4.31, 7.27, 4.58], color: "#15803d", shape: "cone" },
    alphaCutout: true, // blended leaves cost overdraw on the integrated GPU
    triBudget: PROP,
  },
  tree_pine: {
    file: "member-4/Pine by Quaternius - 79gmlLnweB.glb",
    enabled: true,
    owner: "Member 4",
    workbook: "Trees (2 variants)",
    priority: "P2",
    pivot: "bottom-center",
    placeholder: { size: [5.8, 10.24, 5.37], color: "#166534", shape: "cone" },
    alphaCutout: true, // blended leaves cost overdraw on the integrated GPU
    triBudget: PROP,
  },
  grass_patch: {
    file: "Memeber-1/Grass Patch by Danni Bittman - dz_TvM39dC7.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Grass / sidewalk tiles",
    priority: "P2",
    fit: { axis: "x", meters: 3.0 },
    pivot: "bottom-center",
    placeholder: { size: [3, 0.97, 3.07], color: "#4d7c0f", shape: "box" },
    triBudget: PROP,
  },
  path_tile: {
    file: "Memeber-1/Path Straight by Quaternius - ZuRHRsKWoz.glb",
    enabled: true,
    owner: "Member 1",
    workbook: null, // delivered outside the workbook list
    priority: null,
    fit: { axis: "z", meters: 2.0 },
    pivot: "bottom-center",
    placeholder: { size: [1.01, 0.09, 2], color: "#a8a29e", shape: "box" },
    triBudget: PROP,
  },
  bench: {
    file: "Memeber-1/Bench by Ev Amitay - dOSjmdmKaxi.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Benches, bins, hydrants",
    priority: "P3",
    fit: { axis: "z", meters: 1.6 },
    pivot: "bottom-center",
    placeholder: { size: [0.71, 1.05, 1.6], color: "#78350f", shape: "box" },
    triBudget: PROP,
  },
  trashcan: {
    file: "Memeber-1/Trashcan by Quaternius - XSwahu252t.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Benches, bins, hydrants",
    priority: "P3",
    fit: { axis: "y", meters: 1.0 },
    pivot: "bottom-center",
    placeholder: { size: [0.55, 1.0, 0.72], color: "#14532d", shape: "cylinder" },
    triBudget: PROP,
  },
  hydrant: {
    file: "Memeber-1/Hydrant by Jason Wilhelm - 2VLGEGO1HFI.glb",
    enabled: true,
    owner: "Member 1",
    workbook: "Benches, bins, hydrants",
    priority: "P3",
    fit: { axis: "y", meters: 0.8 },
    pivot: "bottom-center",
    placeholder: { size: [0.55, 0.8, 0.34], color: "#dc2626", shape: "cylinder" },
    triBudget: PROP,
  },
} as const satisfies Record<string, AssetEntry>;

export type AssetKey = keyof typeof MANIFEST;
export const ASSET_KEYS = Object.keys(MANIFEST) as AssetKey[];

/** The skybox is an image, not a model: loaded lazily, decoded off the main thread. */
export const SKYBOX = {
  file: "member-2/kloofendal_48d_partly_cloudy_puresky_4k.exr",
  owner: "Member 2",
  workbook: "Skybox / HDRI",
  priority: "P2",
} as const satisfies { file: string; owner: Owner; workbook: string; priority: Priority };

export const MODELS_URL = "/models/";

/** URL of a delivered file (names contain spaces, so each segment is encoded). */
export function modelUrl(file: string): string {
  return MODELS_URL + file.split("/").map(encodeURIComponent).join("/");
}

export function entryOf(key: AssetKey): AssetEntry {
  return MANIFEST[key];
}

/**
 * Background traffic: the SUMO vType (= asset key) and the delivered cars that may show it.
 * Purely visual variety at the simulated size; SUMO's vehicle is the same either way.
 */
export const VEHICLE_VARIANTS: Partial<Record<string, readonly { key: AssetKey; weight: number }[]>> = {
  car_sedan: [
    { key: "car_sedan", weight: 0.5 },
    { key: "taxi", weight: 0.25 },
    { key: "suv", weight: 0.25 },
  ],
};

/** Car paint for tinted parts, chosen per vehicle. */
export const CAR_PAINT = [
  "#e5e7eb", "#9ca3af", "#1f2937", "#b91c1c", "#1d4ed8", "#f8fafc", "#065f46", "#a16207",
] as const;
