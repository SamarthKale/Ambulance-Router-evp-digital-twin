# Attributions

Every 3D asset in the repo needs a row here (CLAUDE.md section 11).

- **Allowed licences:** CC0 or CC-BY. CC-BY credit is also shown in the app's credits panel.
- **Not allowed:** CC-BY-NC, Sketchfab "Standard" or "Editorial", or no clear licence.
- **Preferred sources:** Kenney (CC0) and Quaternius (CC0). Use Sketchfab only for CC0 or CC-BY assets.
- **Ownership and priority** come from `3d_models/EmergencyFlow_3D_Asset_Checklist_Assigned.xlsx` (the source of truth). The Owner and Priority columns below copy it.

## Status: all licences are unconfirmed

The workbook's Source/Link column is empty for every asset. The source and author below are read from the **file names only**, and the licence of every file still has to be confirmed by its owner (fill in Source/Link in the workbook). Until a row says a licence is confirmed, the asset must not ship in a public build.

Validation (Sprint 3, read-only GLB inspection) recorded:
- triangle count
- real-world size after node transforms ("units" when the model isn't in metres)
- named parts
- texture weight

Budgets (CLAUDE.md section 11): about 5k triangles per vehicle and 20k per building.

## Member 1 (`3d_models/Memeber-1/`)

| Workbook asset (priority) | File | Source / author (from file name) | Licence | Validation |
|---|---|---|---|---|
| Ambulance (P1) | Ambulance by Poly by Google - 8NOFImgkI5N.glb | Poly by Google | unconfirmed (Poly models are usually CC-BY 3.0) | 1.9k tris; 21 m long (units); single mesh, **no `siren` or wheel parts**, so it uses the siren-pulse fallback |
| Truck (P2) | Truck by Quaternius - cXw6oiFtZ8.glb | Quaternius | unconfirmed (Quaternius is usually CC0) | 7.5k tris (**over the 5k vehicle budget**); 5.3 m; wheels are separate named parts |
| Streetlight (P2) | Streetlight by Kay Lousberg - vPFSLYh6sg.glb | Kay Lousberg | unconfirmed | 176 tris; 0.96 m tall (units) |
| Grass / sidewalk tiles (P2) | Grass Patch by Danni Bittman - dz_TvM39dC7.glb | Danni Bittman | unconfirmed | 8.5k tris for a grass patch (heavy) |
| Auto-rickshaw (P3) | auto_rickshaw.glb | Sketchfab (no author in file name) | **unknown, must confirm** | 12.6k tris (**over the 5k vehicle budget**); 2.7 m; 2.7 MB |
| Road signs (P3) | Stop sign by Poly by Google - 60GyU9CdZ9r.glb | Poly by Google | unconfirmed (usually CC-BY 3.0) | 236 tris; 231 units tall (units) |
| Road signs (P3) | quaternius_cc0-no-parking-sign-1338.glb | Quaternius (file name says CC0) | CC0 per file name, confirm | 244 tris; 0.54 m (units) |
| Residential block (P3) | Apartment building by Poly by Google - 01lqee-dZAr.glb | Poly by Google | unconfirmed (usually CC-BY 3.0) | 2.1k tris; 18 m tall |
| Benches, bins, hydrants (P3) | Bench by Ev Amitay - dOSjmdmKaxi.glb | Ev Amitay | unconfirmed | 288 tris; 0.72 m (units) |
| Benches, bins, hydrants (P3) | Trashcan by Quaternius - XSwahu252t.glb | Quaternius | unconfirmed (usually CC0) | 739 tris; 2.2 m tall (units) |
| Benches, bins, hydrants (P3) | Hydrant by Jason Wilhelm - 2VLGEGO1HFI.glb | Jason Wilhelm | unconfirmed | 1.3k tris |
| (not in workbook) | Large Building by Kenney - 3IhrYZp6tP.glb | Kenney | unconfirmed (Kenney is usually CC0) | 1.6k tris; 2 m tall (units). Generic buildings belong to Member 2 in the workbook |
| (not in workbook) | Path Straight by Quaternius - ZuRHRsKWoz.glb | Quaternius | unconfirmed (usually CC0) | path tile; roads are generated in code, so probably unused |

## Member 4 (`3d_models/member-4/`)

| Workbook asset (priority) | File | Source / author (from file name) | Licence | Validation |
|---|---|---|---|---|
| Hospital (P1) | Hospital by Poly by Google - asNvyjkcSG1.glb | Poly by Google | unconfirmed (usually CC-BY 3.0) | 12.6k tris; 625 units long (units); pivot well below the base |
| Bus (P2) | Bus by Poly by Google - 4CPpvEmrMoF.glb | Poly by Google | unconfirmed (usually CC-BY 3.0) | 2.2k tris; 157 units long (units) |
| Barricade / road-closed barrier (P2) | Traffic Barrier by Zsky - SInF9le9Ch.glb | Zsky | unconfirmed | 224 tris; pivot below the base |
| Trees (P2) | Pine by Quaternius - 79gmlLnweB.glb | Quaternius | unconfirmed (usually CC0) | 3.4k tris; 10 m tall; 2 MB textures |
| Trees (P2) | Tree by Quaternius - qZtx0AHhcy.glb | Quaternius | unconfirmed (usually CC0) | 6.3k tris; 7 m tall; 2.2 MB textures |
| Fire truck (P3) | Fire Truck by Ivan Klus - 7iHJ519SwxG.glb | Ivan Klus | unconfirmed | 2.1k tris; 1 unit long (units); longest axis is X, so it needs a rotation offset |
| Pedestrian signal (P3) | pedestrian_traffic_light.glb | Sketchfab (no author in file name) | **unknown, must confirm** | 1.5k tris; 402 units tall (cm) |
| Bus stop (P3) | standard_bus_stop.glb | Sketchfab (no author in file name) | **unknown, must confirm** | 11.6k tris; correct size; **23.7 MB, of which 22.6 MB is 11 textures**: resize the textures before use |
| Shops / commercial row (P3)? | model.glb | 3dassets.dev ("bazaar-street-and-shrine-at-trading-hours") | **unknown, must confirm** | **92k tris and 859 nodes** (over the 20k building budget); 181 km (units). Mapping to Shops is a guess from the node names: owner to confirm |
