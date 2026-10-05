# EmergencyFlow — From Hackathon Prototype to Startup

> **Purpose of this document:** to let the team explain, without hand-waving, how EmergencyFlow becomes a company: what we build, what we install, who pays, what is proven, what is not, and what we do next.
> **Rule used throughout:** every claim is tagged **[MEASURED]** (we ran it, numbers in `experiments/`), **[REPORTED]** (a published or press source, linked in section 15), **[ASSUMPTION]** (our plan, not yet tested) or **[TO DO]** (a gap we know about). Nothing untagged. Judges who find a gap we did not name will lose trust, so we name them first (section 13).

---

## 1. The pitch in one paragraph

Ambulances lose time at red lights and in queues at junctions. Signal preemption (turning the signal green for the approaching ambulance) is a known remedy, but it is installed junction by junction with proprietary kit and its benefit is rarely measured fairly. **EmergencyFlow is a verified emergency-priority layer for the traffic signals a city already has.** It has two parts that no one else in our space has together: (1) a **safety layer** that checks every signal change against the junction's conflict rules before it happens and is audited by an independent monitor, and (2) a **simulation testbed** that lets a city measure what the system will save, and what it costs other drivers, *before* a single device is installed. **[MEASURED]** On 560 paired simulation runs, our rule-based preemption cut mean ambulance travel time at heavy demand from **197 s to about 94 s**, with **no measurable delay to other traffic (within ±0.7 %)** and **0 signal-safety violations**.

It is a simulation result, not a field result. The company exists to close that gap safely, one corridor at a time (section 9).

---

## 2. The problem

| Fact | Tag |
|---|---|
| In field deployments in the US, preemption saved roughly 30–45 s per equipped intersection (Fairfax County) and an estimated 10–20 % of response time (Plano, 194 signals); one city reported a 71 % drop in emergency-vehicle crashes (St. Paul). | **[REPORTED]**, US studies compiled by FHWA/USDOT. We have not reproduced them. Open the source PDF before quoting a number on stage. |
| Maharashtra's 108 service is built around the "golden hour" idea and a 20-minute response benchmark; reporting says response times stretch when vehicles are dispatched from farther away. | **[REPORTED]** |
| Indian law already gives ambulances priority and lets them cross red lights while responding, and obstructing an ambulance is an offence (Sec. 194E, MV Act as amended 2019). | **[REPORTED]**, secondary sources. Confirm with a lawyer before relying on it. |
| In our simulation, an ambulance that simply crosses red lights was in a junction collision in 12 of 140 runs (22 events), and saved only 17–34 s. Verified preemption saved 44–119 s with **no** ambulance collision. | **[MEASURED]** with the caveat that SUMO's red-crossing model does not yield to cross traffic. It is evidence for *the direction*, not a crash-rate estimate. |

**Why this matters for the pitch:** crossing red is legal for ambulances but not safe. Giving the ambulance a verified green is both faster and safer in our testbed. That is the problem statement.

---

## 3. The solution and what already exists

```
Ambulance position  ──►  Decision rules (BASIC / COORD)  ──►  SAFETY CONTROLLER  ──►  Signal
(GPS)                    "preempt this junction now"          replays plan vs. conflict      (green + clearance,
                                                              matrix and min yellow/        then back to normal)
                                                              all-red; rejects unsafe  ──►  INDEPENDENT MONITOR
                                                                                            checks what really happened
```

| Component | Status |
|---|---|
| Closed-loop simulator (SUMO), decision rules, safety controller, independent monitor | **Built and tested** (143 backend and 84 frontend tests pass) |
| Live 3D demo where a person drives the ambulance, OFF "ghost" that measures time saved on identical traffic, accident injection with re-routing, LAN dashboard | **Built** |
| Evaluation: 8 arms, paired seeded runs, tuned baseline, bootstrap CIs, exact Wilcoxon, run manifests | **Built, 560 runs** |
| IEEE-format paper draft | **Written**, not yet compiled or peer reviewed |
| **Field adapters** (real GPS in, real controller out) | **[TO DO] Not built.** This is the engineering the funding pays for. |
| Real-signal safety certification, any field data | **[TO DO] None yet.** |

**On "AI":** v1 decision logic is **rule-based** plus shortest-path routing. We say so openly. That is a feature for safety approval: a rule can be audited line by line. ML (traffic and queue prediction, later RL) is a post-v1 roadmap and is **unvalidated**. If it ships, it sits *behind* the same safety layer, and the testbed is how we would prove it earns its place.

---

## 4. Where we fit in Navi Mumbai (the most important slide to get right)

**[REPORTED]** NMMC is rolling out an Intelligent Traffic Management System (ITMS): AI-based, at 58 key junctions, on a PPP basis, with an adaptive signal system (ATCS), number-plate and red-light-violation cameras, and a "**green corridor**" for ambulances and fire engines created by coordinating signals. The first phase is a pilot on Palm Beach Road. Another page reports ATCS already at 63 junctions. The vendor and the specification of the green-corridor part were **not** disclosed in what we found.

**This is the biggest risk to our story, so we position around it instead of ignoring it:**

1. **We are not a rival to the city's ITMS; we are an add-on and a check on it.** Either (a) we supply the emergency-priority logic and safety layer to whoever integrates ITMS, or (b) we act as the independent evaluator and verifier of any green-corridor feature, using the same paired protocol.
2. **We do not assume the ITMS lacks this feature.** **[TO DO, first action]** Ask NMMC for the green-corridor specification and the vendor name before any pitch that claims a gap.
3. If the ITMS already does preemption well, our fallback value is (b) verification plus the other cities and corridors that have no ITMS.

---

## 5. What we would install (the hardware part)

Principle: **minimum new hardware, and the junction's own controller stays in charge.**

### 5.1 Three tiers (we start at Tier A or B, never at C)

| Tier | What is installed | What it gives | When |
|---|---|---|---|
| **A. Software only** | Nothing at the junction. Our service talks to the city's central signal system (ATCS/ITMS) through its API. Ambulance position comes from the operator's existing tracking feed. | BASIC preemption wherever the central system allows priority requests | Best case; depends on the vendor opening an interface |
| **B. Cabinet gateway** | One small industrial computer per junction cabinet, wired to the controller's existing preemption/priority input through an isolated relay or the controller's standard interface (e.g. NTCIP 1202 objects where present; otherwise a vendor gateway). 4G or fibre link. Hardware watchdog. | BASIC preemption at junctions with no usable central API | Most likely for older junctions |
| **C. + Detection** | Queue counts from loops or cameras at the approaches | COORD's queue-aware lead time | Only if a local study shows it pays. **[MEASURED]** COORD gave **no** significant gain over BASIC (|difference| < 5 s, p ≥ 0.28) on our grid, so we do not sell it by default. |

### 5.2 Per-component list

| Item | Where | What it does | Notes |
|---|---|---|---|
| Ambulance position source | Vehicle | GPS + speed over mobile data | **[REPORTED]** the new 108 fleet is specified with GPS, tablets and vehicle tracking. If we can use the operator's feed, **vehicle hardware cost is zero.** Otherwise a rugged 4G GPS tracker. |
| Dispatch status | Operator's dispatch system | Says "this vehicle is on an active emergency run to hospital X" | Required to prevent misuse (section 7). A siren switch alone is not enough. |
| Cabinet gateway | Junction (Tier B) | Receives verified requests, drives the preemption input, reports state | Isolated outputs only: it must never be able to energise a conflicting green by itself. |
| Central server | Cloud or city data centre | Runs ETA, rules, safety controller, monitor, logs | Our engine's logic is reusable; SUMO is replaced by live feeds. |
| Network | Existing | 4G / fibre | Latency is **[TO DO]**: measure on the real link. BASIC asks for green about 15 s before arrival; a position-to-green delay of a few seconds is affordable on paper, but we have not measured it. |

### 5.3 Cost, honestly

We have **no quote**, so we give no price. We give benchmarks from the US, clearly labelled:

- **[REPORTED]** A Texas DOT summary puts GPS-type preemption at about **US$4,000 per intersection** plus about **US$250 per year** to operate; a Roswell, Georgia project came to about **US$7,225 per intersection** (107 signals, US$773,714); a vehicle emitter was estimated near **US$1,000** per vehicle.
- Illustrative arithmetic, **not a quote**: 63 junctions × US$4,000 to US$7,225 = roughly US$250,000 to US$455,000 one-off at US prices; annual operation at US$250 each is about US$16,000 for the lot.
- **What that tells us (and the investor will see it too):** per-junction recurring revenue in this category is small. A viable company therefore needs **many junctions across many cities**, or a bundle with verification and data services. This is not a "huge market from one city" pitch. See section 8.
- **[TO DO]** Get at least two real quotes (gateway computer, relay interface, 4G tracker) and a survey estimate per junction before we show any cost figure to anyone.

### 5.4 The hidden cost: per-junction survey

Each junction needs its approaches, signal groups and phases mapped to our model, and its conflict rules confirmed. In the testbed this comes from the network file; in the field it is a **site survey**. That is probably the biggest per-junction cost and the part that limits how fast we scale. **[ASSUMPTION]** We will cut it by importing the city's own junction data, but we have not tried.

---

## 6. Evidence we can show (and its limits)

| Claim | Number | Tag | Limit that must be said in the same breath |
|---|---|---|---|
| Preemption cuts travel time | 197.1 → ~94 s at demand 1.5 (paired −103 s, 95 % CI −122 to −86, p < 0.001, 40 seeds); −44 / −60 / −103 / −113 to −119 s at demand 0.75 / 1.0 / 1.5 / 2.0 | **[MEASURED]** | Synthetic 4×4 grid, cars only, autopilot drives, simulation only |
| No cost to others | Background delay change within ±0.7 %, never significant | **[MEASURED]** | Short, tuned signal cycles; a 74 s cycle could differ |
| Verified safe | 0 violations of the three safety rules in 560 runs; 0 ambulance collisions in BASIC, COORD and OFF-strict (420 runs) | **[MEASURED]** | Checked in the simulator. Not a field safety certificate. |
| Baseline is fair | OFF baseline uses signal timing tuned by Webster's method for each demand | **[MEASURED]** | The tuning is SUMO's tool, not the city's real plan |
| Coordination adds nothing here | COORD − BASIC under 5 s, p ≥ 0.28 | **[MEASURED]** | Why we recommend BASIC first |
| Re-routing adds nothing without incidents | < 6 s difference | **[MEASURED]** | Incident experiments not run in batch: **[TO DO]** |
| Time saved is measured, not estimated | Live OFF ghost on identical traffic | **[MEASURED]** | Only for the first dispatch after a reset |

We *keep* the negative results in the pitch. A team that reports what did not work is more believable on what did.

---

## 7. Safety, misuse and failure (what stops this from hurting anyone)

| Risk | Design response | Status |
|---|---|---|
| Unsafe signal state | Controller replays every plan against the junction conflict matrix, 4 s yellow, 2 s all-red; independent monitor re-checks the real states; unsafe plans rejected | **[MEASURED]** in simulation |
| The field controller's own protection | The controller's conflict monitor and minimum timings stay authoritative. Ours is an extra layer, never a bypass. | **[ASSUMPTION]** Needs per-controller sign-off |
| Someone fakes an ambulance to get green lights | Requests accepted only from registered vehicle IDs *and* an active dispatch from the operator; rate limits; every request logged with a reason | **[TO DO]** designed, not built. Our current check is "vehicle class = emergency" in simulation. |
| GPS or network lost | No position → no request → the junction runs its normal program; 40 s limit and a recovery sequence if something is stuck | Timeout and recovery **[MEASURED]** in simulation; link-loss **[TO DO]** in the field |
| Server crash or software error | Every junction recovers with full clearance and falls back to normal signals (tested) | **[MEASURED]** in simulation |
| Two ambulances at once | v1 handles **one**. Multi-vehicle coordination is not built. | **[TO DO]**, stated limitation |
| Pedestrians, two-wheelers, auto-rickshaws | Not modelled in the testbed | **[TO DO]** |
| Liability | Unresolved. Needs the city's written approval, insurance and a legal opinion before any live signal is touched. | **[TO DO]** |

**We will never claim to control real signals today.** The demo says "simulation testbed" on screen.

---

## 8. Business model

### 8.1 Who pays and why

| Customer | Pain | Why they pay | Reality check |
|---|---|---|---|
| **Municipal corporation / smart-city cell** (NMMC; later others) | Slow response, public pressure, ITMS being rolled out | Verified faster ambulance corridors without replacing signals | Government procurement is slow. We depend on written approvals. |
| **ITMS / signal integrators** | Need a safe, tested priority feature | License our logic and safety layer instead of building it | Likely the faster channel. Also the likeliest competitor, section 10. |
| **Ambulance operators** (e.g. the 108 operator) | Response-time targets | Mostly a data partner and beneficiary; may fund vehicle-side work | They need a reason to share data. **[TO DO]** |
| **Hospitals** | Door-to-treatment time | Possible sponsor of a specific corridor | Weak. Treat as a later extra, not the plan. |

### 8.2 Revenue streams (in the order we can actually start them)

1. **Evaluation and planning study**: we run the testbed on a city's own network and demand and report time saved, cost to other traffic and safety, with the same paired protocol. **Needs no hardware and works today.** One-off fee. This is our first revenue and our proof of value.
2. **Pilot and integration**: one corridor, shadow mode first (section 9). Project fee.
3. **Per-junction annual subscription**: hosting, monitoring, updates, support, safety audit reports.
4. **Hardware pass-through** (gateways, trackers) at a modest margin. Not the main business.

**[ASSUMPTION]** No price has been tested with any customer. We state the structure, not numbers. Before pitching a price, ask two or three real buyers.

### 8.3 Unit economics (the formula, to be filled with real quotes)

```
Per junction, per year   = subscription − (hosting + support + monitoring + amortised survey and gateway cost)
Company break-even       = fixed team and compliance cost ÷ per-junction margin   (junctions needed)
```

Using the US benchmark above, operation alone is about US$250 per junction per year, so **thin per-junction margin is the base case.** The company works only if (a) many junctions share one server and one team, and (b) studies, integrations and verification services add revenue that does not scale with junction count.

### 8.4 Moat (what is hard to copy)

Preemption logic is simple, and rule-based logic can be copied. We do **not** claim the rules are the moat. What is slower to copy:
- the **verified safety layer** and its audit trail, which are what a city's engineers and regulators need to see
- the **reproducible evaluation** and the growing body of paired results across cities
- **integrations and relationships** with the city, the operator and the signal vendor
- later, **data** for the prediction models, which only exists once we are in the field

### 8.5 Funding

- **Ask: [TO DO, team to decide].** Do not state a figure until the quotes exist.
- **Use of funds (by milestone, not by amount):** (1) field adapters and the abuse-proof request path; (2) site survey tooling; (3) the shadow-mode pilot; (4) legal, safety review and insurance; (5) one engineer for integration work.
- **Release in tranches tied to the gates in section 9.** An investor funds the next gate only when the last one is passed. That keeps risk visible and small.

---

## 9. Roadmap with gates

| Stage | What we do | Gate (we move on only if) |
|---|---|---|
| **0. Now** | Finish the paper, polish the demo, collect letters/emails of support from NMMC. Get the ITMS green-corridor spec. | NMMC confirms in writing that we can use its name and share its network data |
| **1. Paper study on a real network** | Import a real NMMC corridor into the testbed; run the evaluation; hand the city a report. No hardware. | City engineers accept the method and the report |
| **2. Replay** | Replay recorded ambulance GPS tracks (from the operator) through the model | Predictions match what happened to within an agreed error |
| **3. Shadow mode** | Live ambulance positions, our system *computes* what it would do and logs it against the real signal state. **Nothing is sent to any signal.** | No unsafe request would have been generated; latency measured; operator's data flow reliable |
| **4. One-corridor pilot** | Tier A or B on a handful of junctions, with the traffic authority's written approval and its own controller protections on | Zero safety events, measured time saved, no measurable harm to cross traffic |
| **5. Scale** | Extend corridors, add cities and integrators, consider detection (Tier C) and prediction models | Unit economics positive per corridor |

**Honest timing:** we give gates, not dates, because stages 3 to 5 depend on approvals we do not control.

---

## 10. Competition

| Who | What they do | Our honest position |
|---|---|---|
| Established preemption vendors (US names include EMTRAC, Appinfo, Traffic Control Corp. and others) | Proven, field-installed, emitter or GPS-based preemption **[REPORTED]** | They have field track records, certification and support; we have none. Our edge is verification, evaluation and low-friction integration, not a better emitter. We do not have local-market proof that they serve India. |
| Local ITMS integrators (e.g. whoever wins NMMC's PPP) | Bundled ATCS, cameras and a planned green corridor | Possible rival **and** channel. We should aim to be the verified component they license, or the independent checker. |
| "Do nothing" (sirens, manual police clearing, current exemptions) | Free, familiar | We must show a measured gain *and* lower risk than red-crossing |

---

## 11. The 3-minute pitch flow (what to show, tied to the claim it proves)

1. **Problem (30 s):** one slide: ambulances lose time at junctions; red-crossing is legal but our simulation shows it is dangerous.
2. **Live demo (60 s):** dispatch in OFF → the translucent OFF ghost sets off with you → switch to BASIC: green appears after clearance → press *Create accident*: route recalculates → HUD shows measured time saved against the ghost. *Proves: verified preemption works and the number is measured, not guessed.*
3. **Evidence (30 s):** press **R**: in-app chart with confidence intervals: 197 → ~94 s, background delay unchanged, 0 violations in 560 runs. *Say the limit in the same sentence: simulation.*
4. **Business (45 s):** evaluation study today, shadow-mode pilot next, per-junction subscription later; Tier A/B hardware; fits beside NMMC's ITMS.
5. **Ask (15 s):** support for the one-corridor shadow-mode pilot, tranche one.

**Demo-day checks:** laptop on AC power, Edge on the RTX 4060, Wi-Fi set to *Private* if showing the dashboard on another PC, press **Reset** before the run so the ghost works.

---

## 12. Questions a judge or investor will ask (and the answers)

| Question | Answer |
|---|---|
| **Is this real AI?** | The decision logic is rule-based plus shortest-path routing, and we say that. Rules are auditable, which matters for safety approval. ML for prediction is the roadmap and sits behind the same safety layer; the testbed is how we would prove it helps. |
| **Does it work in the real world?** | Not yet proven; all numbers are from simulation. That is why the plan starts with shadow mode and a single corridor, with gates. |
| **Is the simulation even valid?** | It is a standard traffic simulator (SUMO), our baseline is tuned, runs are paired on identical traffic, and we report intervals and p-values. Limits: synthetic grid, cars only, no two-wheelers or pedestrians. Calibrating to Navi Mumbai data is stage 1. |
| **Isn't NMMC's ITMS already doing green corridors?** | It plans to **[REPORTED]**; we have not seen the specification. We position as a safe, verified add-on or independent checker, and we will request the spec. If it already works well, our value is verification and other cities. |
| **What do you install?** | Tier A: nothing at the junction. Tier B: one small gateway in the cabinet wired to the controller's own preemption input, with the controller's protections still in charge. Vehicle: the operator's existing GPS if shared, otherwise a 4G tracker. |
| **What if it fails?** | No position or link → no request → the junction runs its normal program. Software error → controller recovers every junction with full clearance and drops to normal signals. These behaviours are tested in simulation, and field link-loss testing is stage 3. |
| **Can someone abuse it to get green lights?** | Requests need a registered vehicle *and* an active dispatch from the operator, plus rate limits and logs. **Designed, not built yet.** |
| **Will it delay other drivers?** | In simulation, not measurably (within ±0.7 %, never significant). The paired design reports the cost next to the benefit. A field pilot must re-measure it. |
| **Will it cause accidents at the junction?** | The safety layer rejects conflicting greens and enforces 4 s yellow and 2 s all-red; the monitor found 0 violations in 560 runs. The simulator also showed the alternative (crossing red) had ambulance collisions in 12 of 140 runs. In the field, the controller's own conflict monitor stays in force. |
| **Why would a city pay?** | Evaluation study first: a measured answer for its own network with no hardware. Then a pilot, then a per-junction subscription. **No price has been tested yet.** |
| **How big is the market?** | We do not have a validated number and will not invent one. Benchmarks suggest thin per-junction revenue (US$250 a year to operate in one US estimate), so the business needs many junctions, many cities or bundled services. |
| **Why you and not an established vendor?** | We do not claim a better device. We offer verification, reproducible evaluation and low-friction integration. Established vendors have field track records we lack. |
| **What is your moat?** | Not the rules. The audit trail, the evaluation evidence, integrations and relationships, and later field data. |
| **Who is on the team and what are you missing?** | **[TO DO: fill in names and roles.]** Honest gaps: field/traffic-engineering experience, legal, and a government-procurement contact. We would add these through advisors or hires. |
| **Does the government actually support this?** | The project is supported by NMMC (IAS Administration) and acknowledged by the two MLAs named in the paper, and proposed to MMRDA. **That is support, not a purchase order.** Have the letters or emails ready. |
| **What about two ambulances, buses, trucks, pedestrians?** | Not built or modelled. Multi-vehicle priority is on the roadmap; heavy vehicles need protected-turn phases. |
| **How do you scale past one city?** | The testbed imports a network and runs; the per-junction survey is the bottleneck, and we plan to use the city's own junction data to cut it. **Not yet tested.** |
| **How long until revenue?** | An evaluation study can start as soon as a city shares network data. Hardware revenue depends on approvals, so we give gates, not dates. |
| **Is the software open?** | The testbed is built to be open and reproducible; what we sell is the verified field layer, integrations and support. Confirm the licence choice with the team before saying so. **[TO DO]** |
| **Can you show the numbers again?** | Press **R** in the app, or open `experiments/summary/`. Every run has a manifest with the code version and seed. |

---

## 13. Cross-critique: the weakest points of this plan

We attacked our own plan. These are the holes, ranked by how much damage they could do, with what we do about each.

1. **We have no field data.** Everything is simulation. *Response:* never present it otherwise; staged gates; shadow mode before any live signal.
2. **NMMC's ITMS may already include green corridors.** *Response:* get the spec first; position as add-on or verifier (section 4). If the answer is bad, pivot to verification and other cities.
3. **The per-junction market is thin.** *Response:* admit it; build revenue that does not scale with junctions (studies, verification, integration licences) and target many cities.
4. **No price or customer has been tested.** *Response:* talk to two or three real buyers (a municipal engineer, an integrator, the ambulance operator) before showing any price.
5. **The "AI" label can be challenged.** *Response:* we call the logic rule-based everywhere, including the paper. We never say COORD or the router is machine learning.
6. **The misuse-proof request path is designed, not built.** *Response:* say "designed", list it as the first field-adapter work item.
7. **Single ambulance only; no pedestrians or two-wheelers.** *Response:* stated limitation; roadmap item.
8. **Support is not a contract.** *Response:* get written confirmation of what NMMC and the MLAs agree to being named for. Conferences and investors treat acknowledgments as factual claims.
9. **Team and legal gaps** (no named traffic-engineering or legal adviser; liability unresolved). *Response:* recruit advisors; legal opinion before stage 4.
10. **Several external facts come from press summaries, not primary documents** (ITMS scope, 108 fleet, legal exemption, US field results). *Response:* open the linked sources and quote only what you have read. Remove anything you cannot back up.
11. **Cost figures are US benchmarks, not quotes.** *Response:* label them as such every time; get local quotes.
12. **The pitch must not overpromise safety.** *Response:* "verified in simulation by two independent checks" is true; "safe on real roads" is not yet true.

---

## 14. Things to do before presenting (checklist)

- [ ] Open each source in section 15 and confirm the numbers you plan to quote.
- [ ] Ask NMMC for the ITMS green-corridor specification and vendor.
- [ ] Get written confirmation of the NMMC / MLA / MMRDA wording.
- [ ] Fill in the team, roles and the funding ask.
- [ ] Get two or more real hardware quotes (gateway, relay interface, 4G tracker).
- [ ] Compile the paper (Overleaf) and fill in author names.
- [ ] Rehearse the demo, including the Wi-Fi *Private* setting and the **Reset** before the run.
- [ ] Practise the answers in section 12 out loud; the weakest ones are 1, 2, 4 and 5 in section 13.

---

## 15. Sources (retrieved 2026-10-06; check before quoting)

- FHWA, *Emergency Vehicle Preemption (EVP)* (2024): <https://ops.fhwa.dot.gov/publications/fhwahop24019/fhwahop24019.pdf>
- USDOT, *Traffic Signal Preemption for Emergency Vehicles* (field results compilation, source of the Fairfax/Plano/St. Paul figures as summarised in our search): <https://rosap.ntl.bts.gov/view/dot/3655/dot_3655_DS1.pdf>
- USDOT ITS Knowledge Resources, TxDOT preemption cost (about US$4,000 per intersection, US$250 per year): <https://www.itskrs.its.dot.gov/2022-sc00523>
- Roswell, Georgia preemption project (US$773,714 for 107 intersections): <https://roswellconnections.com/trafficpreemption/>
- Lokshahi, Navi Mumbai ITMS at 58 junctions, PPP, ATCS, green corridor (12 June 2026): <https://english.lokshahi.com/maharashtra/navi-mumbai-to-get-ai-powered-smart-traffic-system-as-authorities-aim-to-reduce-congestion-and-improve-road-safety-58-key-junctions-to-be-upgraded-under-advanced-itms-project-12031332>
- Mumbai Live, ITMS first phase on Palm Beach Road: <https://www.mumbailive.com/en/civic/intelligent-traffic-management-system-to-be-installed-soon-in-navi-mumbai-91112>
- NIUA ICCC use case (ATCS at 63 junctions, as shown in search snippet; **not opened**): <https://iccc.niua.org/iccc/sector/use-case/815e6212def15fe76ed27cec7a393d59>
- Maharashtra 108 service contract and fleet (about 1,756 ambulances, GPS and tablets): <https://www.mypunepulse.com/maharashtra-health-dept-signs-%E2%82%B91600-crore-deal-for-108-ambulance-services-amid-allegations-of-irregularities/>
- Maharashtra EMS (official): <https://nhm.maharashtra.gov.in/en/scheme/maharashtra-emergency-medical-services-mems-emergency-medical-service-on-call/>
- Ambulance traffic-rule summaries (secondary; confirm with a lawyer): <https://vmedo.com/blog/traffic-rules-for-ambulances-in-india/> and <https://saferoadlife.in/emergency-vehicles-on-indian-roads-and-exemptions-for-breaking-traffic-rules/>
- Our own results: `experiments/summary/summary.json`, `experiments/summary/paired.csv`, `experiments/summary/collisions.csv`, `paper/emergencyflow.tex`, and `README.md` (Evaluation results).
