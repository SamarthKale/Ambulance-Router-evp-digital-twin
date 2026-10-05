# Attributions

Every 3D asset in the repo has a row here (CLAUDE.md section 11).

- **Licensing:** the team confirmed on 2026-10-05 that every delivered `.glb` is purchased or licensed for project use. Credit is recorded below where the file name gives the source or author. An empty Source/Link field in the workbook does not block an asset.
- **Ownership and priority** come from `3d_models/EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx` (the source of truth). The asset and priority columns below copy it.
- **Delivered files are used exactly as delivered.** They are never compressed, simplified, resized, replaced or renamed unless the team says so. Scale, rotation and pivot are calibrated in the manifest; weight is handled in the renderer.

Validation (Sprint 3, read-only GLB inspection) recorded:
- triangle count
- real-world size after node transforms ("units" when the model isn't in metres, so the manifest's `fit` rescales it)
- named parts
- texture weight

Triangle guideline (CLAUDE.md section 11): about 5k per vehicle and 20k per building. It's a renderer performance target, not a reason to edit a file.

## Member 1 (`3d_models/Memeber-1/`)

| Workbook asset (priority) | File | Source / author (from file name) | Licence | Validation |
|---|---|---|---|---|
| Ambulance (P1) | Ambulance by Poly by Google - 8NOFImgkI5N.glb | Poly by Google | licensed for project use (team) | 1.9k tris; 21 m long (units); single mesh, **no `siren` or wheel parts**, so it uses the siren-pulse fallback |
| Truck (P2) | Truck by Quaternius - cXw6oiFtZ8.glb | Quaternius | licensed for project use (team) | 7.5k tris (above the vehicle guideline); 5.3 m; wheels are separate named parts |
| Streetlight (P2) | Streetlight by Kay Lousberg - vPFSLYh6sg.glb | Kay Lousberg | licensed for project use (team) | 176 tris; 0.96 m tall (units) |
| Grass / sidewalk tiles (P2) | Grass Patch by Danni Bittman - dz_TvM39dC7.glb | Danni Bittman | licensed for project use (team) | 8.5k tris for a grass patch |
| Auto-rickshaw (P3) | auto_rickshaw.glb | Sketchfab (no author in file name) | licensed for project use (team) | 12.6k tris (above the vehicle guideline); 2.7 m; 2.7 MB |
| Road signs (P3) | Stop sign by Poly by Google - 60GyU9CdZ9r.glb | Poly by Google | licensed for project use (team) | 236 tris; 231 units tall (units) |
| Road signs (P3) | quaternius_cc0-no-parking-sign-1338.glb | Quaternius | licensed for project use (team) | 244 tris; 0.54 m (units) |
| Residential block (P3) | Apartment building by Poly by Google - 01lqee-dZAr.glb | Poly by Google | licensed for project use (team) | 2.1k tris; 18 m tall |
| Benches, bins, hydrants (P3) | Bench by Ev Amitay - dOSjmdmKaxi.glb | Ev Amitay | licensed for project use (team) | 288 tris; 0.72 m (units) |
| Benches, bins, hydrants (P3) | Trashcan by Quaternius - XSwahu252t.glb | Quaternius | licensed for project use (team) | 739 tris; 2.2 m tall (units) |
| Benches, bins, hydrants (P3) | Hydrant by Jason Wilhelm - 2VLGEGO1HFI.glb | Jason Wilhelm | licensed for project use (team) | 1.3k tris |
| (not in workbook) | Large Building by Kenney - 3IhrYZp6tP.glb | Kenney | licensed for project use (team) | 1.6k tris; 2 m tall (units). Generic buildings belong to Member 2 in the workbook |
| (not in workbook) | Path Straight by Quaternius - ZuRHRsKWoz.glb | Quaternius | licensed for project use (team) | path tile; roads are generated in code |

## Member 4 (`3d_models/member-4/`)

| Workbook asset (priority) | File | Source / author (from file name) | Licence | Validation |
|---|---|---|---|---|
| Hospital (P1) | Hospital by Poly by Google - asNvyjkcSG1.glb | Poly by Google | licensed for project use (team) | 12.6k tris; 625 units long (units); pivot well below the base |
| Bus (P2) | Bus by Poly by Google - 4CPpvEmrMoF.glb | Poly by Google | licensed for project use (team) | 2.2k tris; 157 units long (units) |
| Barricade / road-closed barrier (P2) | Traffic Barrier by Zsky - SInF9le9Ch.glb | Zsky | licensed for project use (team) | 224 tris; pivot below the base |
| Trees (P2) | Pine by Quaternius - 79gmlLnweB.glb | Quaternius | licensed for project use (team) | 3.4k tris; 10 m tall; 2 MB textures |
| Trees (P2) | Tree by Quaternius - qZtx0AHhcy.glb | Quaternius | licensed for project use (team) | 6.3k tris; 7 m tall; 2.2 MB textures |
| Fire truck (P3) | Fire Truck by Ivan Klus - 7iHJ519SwxG.glb | Ivan Klus | licensed for project use (team) | 2.1k tris; 1 unit long (units); longest axis is X, so it needs a rotation offset |
| Pedestrian signal (P3) | pedestrian_traffic_light.glb | Sketchfab (no author in file name) | licensed for project use (team) | 1.5k tris; 402 units tall (cm) |
| Bus stop (P3) | standard_bus_stop.glb | Sketchfab (no author in file name) | licensed for project use (team) | 11.6k tris; correct size; 23.7 MB (22.6 MB of textures): load lazily, never re-encode |
| Shops / commercial row (P3) | model.glb | 3dassets.dev ("bazaar-street-and-shrine-at-trading-hours") | licensed for project use (team) | 92k tris and 859 nodes (above the building guideline; used as-is); 181 km (units); mapping confirmed by the team |

## Member 2 (`3d_models/member-2/`)

| Workbook asset (priority) | File | Source / author (from file name) | Licence | Validation |
|---|---|---|---|---|
| Sedan (P1) | sedan.glb | (no source in file name) | licensed for project use (team) | 3.1k tris; 3.9 m, real scale; body and wheels are separate parts |
| Generic buildings, 3-5 variants (P1) | Large Building by Kenney - h7Jaq7bqMq.glb | Kenney | licensed for project use (team) | 2.1k tris; 2.5 m tall (units) |
| Generic buildings (P1) | quaternius_cc0-building-747.glb | Quaternius | licensed for project use (team) | 9.7k tris; 5.5 m tall (units) |
| Generic buildings (P1) | quaternius_cc0-small-building-746.glb | Quaternius | licensed for project use (team) | 5.2k tris; 5.7 m tall (units) |
| Generic buildings (P1) | Apartment building by Poly by Google - 01lqee-dZAr.glb | Poly by Google | licensed for project use (team) | same model as Member 1's Residential block; 2.1k tris; 18 m tall |
| Hatchback (P2) | Car Hatchback by Kay Lousberg - BG0KAhmGDt.glb | Kay Lousberg | licensed for project use (team) | 1.2k tris; 0.81 units long (units); four separate wheel parts |
| Stop line / zebra crossing (P2) | street-tile-c7e3cf.glb | (no source in file name) | licensed for project use (team) | 188 tris; 8 x 8 m street tile with a separate `street-surface` part; mapped by elimination within Member 2's list |
| Crashed or wrecked car (P2) | Crashed wrecked car gltf/Crashed wrecked car.gltf (+ .bin + 2 PNG textures) | (no source in file name) | licensed for project use (team) | multi-file glTF, all referenced files present; 49.8k tris; 24.8 MB (23 MB textures); 1.2 units long (units) |
| Skybox / HDRI (P2) | kloofendal_48d_partly_cloudy_puresky_4k.exr | (no source in file name) | licensed for project use (team) | valid OpenEXR, 4k; 72 MB: load lazily |
| Two-wheeler (P3) | Scooter by Poly by Google - eHdEFPwUfCt.glb | Poly by Google | licensed for project use (team) | 1.5k tris; 120 units long (units) |
| Divider / median (P3) | divider.glb | (no source in file name) | licensed for project use (team) | 232 tris; 1.9 m barrier segment |
| Petrol pump (P3) | Gas Station by Alex Safayan - 7rUkCX-AIR2.glb | Alex Safayan | licensed for project use (team) | 53.9k tris and 263 nodes (above the building guideline; used as-is); 8.7 m |
| Petrol pump (P3) | jerryblessed-fuel-5054.glb | jerryblessed | licensed for project use (team) | 324 tris; 1.76 m pump; separate named parts |

## Member 3 (`3d_models/member-3/`)

| Workbook asset (priority) | File | Source / author (from file name) | Licence | Validation |
|---|---|---|---|---|
| Traffic light, pole + 3 lamps (P1) | traffic_light.glb | (no source in file name) | licensed for project use (team) | 1.7k tris; 4.05 m tall, real scale; lamps are separate parts **`Red_Light`, `Yellow_Light`, `Green_Light`** (mapped to `lamp_red`/`lamp_yellow`/`lamp_green` by manifest aliases) |
| SUV / van (P2) | SUV.glb | (no source in file name) | licensed for project use (team) | 3.3k tris; 4.2 m, real scale; wheels are separate parts |
| Traffic cones (P2) | traffic_cone.glb | (no source in file name) | licensed for project use (team) | 140 tris; 1.26 m (units) |
| Road-block marker (P2) | road_block_marker.glb | (no source in file name) | licensed for project use (team) | 112 tris; 1.6 m barricade |
| Police car (P3) | police_car.glb | (no source in file name) | licensed for project use (team) | 9.9k tris (above the vehicle guideline); 0.22 units long (units); 4.8 MB; includes a `sceneGroundPlane` node |
| Taxi (P3) | taxi.glb | (no source in file name) | licensed for project use (team) | 3.3k tris; 4.2 m, real scale; wheels are separate parts |
| Explosion / impact marker (P3) | explosion_marker.glb | (no source in file name) | licensed for project use (team) | 240 tris; 3 nested shells |
| Flyover / bridge (P3) | flyover.glb | (no source in file name) | licensed for project use (team) | 480 tris; 60 m deck |
