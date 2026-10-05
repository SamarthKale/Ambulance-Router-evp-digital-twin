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

### 5.5 Retrofit ("slap-on") design: how it goes onto equipment that already exists

Goal: **replace nothing.** We add at most one small box per junction cabinet and, if the operator shares its tracking feed, nothing on the ambulance.

| # | Design rule | Why it keeps cost and risk low | Tag |
|---|---|---|---|
| 1 | **Use the ambulance's existing GPS.** The new 108 fleet is reported to be specified with GPS and vehicle tracking. | No vehicle hardware at all. If we must add one, AIS-140 trackers are listed at about ₹3,800 to ₹15,500 depending on certification, and only for pilot ambulances. | **[REPORTED]** (trade listings, vary by seller) |
| 2 | **No detectors, cameras or roadside emitters.** Position comes from GPS, so no optical emitter on each ambulance and no receiver at each signal head. | Emitters and receivers are the per-vehicle and per-junction cost items of emitter-based systems (one US estimate: about US$1,000 per vehicle emitter). | **[REPORTED]** for the US figure; our saving is **[ASSUMPTION]** until we have quotes |
| 3 | **Connect to the controller's input, never to the lamps.** Our box closes a dry-contact relay into the controller's own external/preemption input, the same kind of input emitter systems use. | Relay unpowered = no request = normal operation. Our hardware physically cannot show a green by itself, so a fault in our box cannot create an unsafe signal state. The controller's conflict monitor stays in the loop. | **[ASSUMPTION]** Needs a usable input on the installed controller. Check the cabinets of the first three junctions. |
| 4 | **Hardware timer and heartbeat watchdog on the relay.** The relay drops after a fixed maximum (matching the software's 40 s limit) even if our computer hangs, and drops if the link goes silent. | A second safety net that does not depend on our software. | **[TO DO]** designed, not built |
| 5 | **One shared server** for all junctions. | Software cost does not grow per junction. Hardware cost scales only with the number of cabinet boxes. | **[ASSUMPTION]** |
| 6 | **Install by the city's authorised contractor** (or its vendor), not by us opening live cabinets alone. | Avoids our liability and the city's safety rules. | **[TO DO]** agree with NMMC |

**If a junction cannot be retrofitted** (no free input, closed vendor controller), in order: (a) Tier A through the central system's API; (b) ask the controller vendor to enable the input (a setting or a paid option, we do not know which, **[TO DO]**); (c) leave that junction out. A corridor with some junctions equipped still helps in principle, but **we have not measured partial deployment**. It is a cheap next experiment in the testbed (preempt at a subset of junctions), so we propose to run it. **[TO DO]**

**Cost statement we can defend:** "We put nothing on the vehicle if the operator shares its GPS, we add no detectors, and we touch one controller input per cabinet. That removes the main cost items of emitter-based systems. Whether our total per junction is lower is what our first quotes must prove." We do not say "cheaper" until we have quotes. The **benchmark to beat** is US$4,000 to US$7,225 per junction (US projects, **[REPORTED]**).

| Part | What we know about price |
|---|---|
| Ambulance tracker | ₹0 if the operator's feed is shared; otherwise about ₹3,800 to ₹15,500 per unit in trade listings **[REPORTED]** |
| Cabinet box (small computer, isolated relay, 4G modem, surge protection, weatherproof enclosure) | **No quote.** Hobby-grade parts are cheap, but field-grade (heat, surge, ingress protection) costs more. **[TO DO]** two quotes |
| Survey and installation labour | **No quote**, probably the largest share per junction **[ASSUMPTION]** |
| Server | Shared cloud or city data centre; small next to the junction costs **[ASSUMPTION]** |

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

## 11. The pitch split across five speakers

**Rule of the stage: one owner per topic.** Only **P2** explains how the software works. Only **P3** talks about what is installed and what it costs. Only **P4** talks about money and revenue. Only **P5** talks about whether it can work in the real world, the risks and the ask. **P1** opens and does not explain anything technical. Nobody else answers outside their topic: they hand over with the line *"[Name] owns that, let me pass it."* That removes contradictions, which is how most teams get caught.

| Speaker | Role | Time | One-sentence version (for a 2-minute slot) |
|---|---|---|---|
| **P1** | Opener: problem, hook, what we built, who backs us | ~60 s | "Ambulances still wait at red lights, and our simulation shows crossing red is where they crash." |
| **P2** | **Technical lead**: architecture, safety, live demo, evidence | ~100 s | "We give them a verified green: every signal change is checked twice, and in 560 simulated runs travel time fell from 197 to about 94 seconds, with no measurable delay to others and no safety violation." |
| **P3** | Hardware: what we install, retrofit, cost | ~60 s | "It goes onto what cities already have: one small box in the junction cabinet feeding the controller's own input, and nothing new on the ambulance if the operator shares its GPS." |
| **P4** | Business model: who pays, how we earn | ~70 s | "We start by selling a no-hardware evaluation to a city, then a pilot, then a per-junction subscription, through the companies already building the city's traffic system." |
| **P5** | Feasibility and viability: gates, risks, support, the ask | ~70 s | "We move in gated stages (study, replay, shadow mode, one corridor) and ask for the first tranche to run shadow mode." |

Total about 6 minutes. For a shorter slot, use the one-sentence versions (about 2 minutes) and keep the demo.

### Numbers card (everyone uses exactly these, and says "simulation" with every result)

- **197 s → about 94 s** at demand 1.5 (paired −103 s, 95 % CI −122 to −86, p < 0.001), 40 seeds; **560 runs** in all.
- Other traffic's delay within **±0.7 %**, never significant. **0 safety violations** in 560 runs. **0 ambulance collisions** in 420 BASIC, COORD and OFF-strict runs.
- Ambulance crossing red lights: in a collision in **12 of 140 runs**, saved only 17 to 34 s.
- COORD vs BASIC: under 5 s, not significant.
- **143 + 84** automated tests pass.
- NMMC's reported ITMS: **58 junctions**. US cost benchmark: **US$4,000 to US$7,225 per junction**, about US$250 a year to run. Ambulance tracker listings: **₹3,800 to ₹15,500**.

---

### P1: Opener (about 60 s)

**Say**
- Hook: "An ambulance with its siren on still waits at a red light. The law lets it cross. Our simulation shows that is where it gets into collisions."
- "Preemption, turning the signal green for the ambulance, is a known fix. But it is installed junction by junction, and its benefit is rarely measured fairly."
- "We built **EmergencyFlow**: a verified emergency-priority layer for the signals a city already has, plus a simulation testbed that measures what it saves and what it costs other drivers before anything is installed."
- Headline: "In simulation, ambulance travel time fell from 197 to about 94 seconds."
- Support, stated exactly: "The project is supported by NMMC, IAS Administration, acknowledged by the two MLAs, and proposed to MMRDA."
- Hand-off: "[P2] will show it running."

**Do not**
- Explain how the safety layer works, quote any cost, or say it works on real roads.
- Say "supported" as if it were an order or a contract.

**Owns questions:** none. Pass everything.

---

### P2: Technical lead (about 100 s, the only person who explains the technology)

**Say (about 20 s, architecture)**
- "SUMO, a standard traffic simulator, is the single source of truth. Rules propose a signal change. A **safety controller** replays it against the junction's conflict matrix and the 4-second yellow and 2-second all-red, and rejects anything unsafe. A **separate monitor** then checks the states the simulator really produced. Two independent checks."
- "The decision logic is **rule-based**, not machine learning, and that is deliberate: a rule can be audited."

**Do (about 60 s, live demo)**
1. Dispatch in OFF: the translucent **OFF ghost** sets off on the same traffic.
2. Switch to **BASIC**: the signal goes green after yellow and all-red clearance.
3. Switch to **COORD**: junctions ahead are prepared.
4. **Create accident**: the route is recalculated and shows "route compromised".
5. On arrival the HUD shows the **measured** time saved against the ghost.

**Say (about 20 s, evidence)**
- "560 paired runs on identical traffic, against a signal plan tuned for each demand so the baseline is not a strawman: 197 to about 94 seconds, other traffic within ±0.7 %, 0 violations. We also report what did not help: coordination and re-routing added nothing without accidents."
- "All of this is simulation."
- Hand-off: "[P3] will explain what we install."

**Do not**
- Quote prices, claim field results, or call COORD or the routing machine learning.

**Owns questions:** how rules and safety work, simulation validity, the "is it AI" question, abuse prevention, software failure, two ambulances, the numbers and charts. Keep the app open on the **R** chart.

---

### P3: Hardware (about 60 s)

**Say**
- "Our principle: **replace nothing.**"
- "On the vehicle: nothing, if the ambulance operator shares the GPS feed its fleet is reported to have. Otherwise one tracker, listed at a few thousand rupees, only for pilot ambulances."
- "At the junction: no cameras, no detectors, no emitters. One small box in the cabinet closes a relay into the **controller's own preemption input**. It never touches the lamps, so a fault in our box cannot create a green by itself. A hardware timer and watchdog drop the request even if our software hangs."
- "The city's controller keeps its own conflict protection. Ours is an extra layer."
- "Where a junction cannot take it, we connect through the city's central signal system instead, or leave that junction out."
- Cost, stated safely: "Emitter-based systems in the US cost about US$4,000 to US$7,225 per junction plus equipment on every vehicle. We remove the vehicle equipment and the detectors. **Our own quotes are the next step**, and we will not claim a total before we have them."
- Hand-off: "[P4] will explain how this earns revenue."

**Do not**
- Say "cheaper" without a quote, quote a cabinet-box price, or say it works with every controller. The input on the installed controllers is **unverified** until the first three cabinets are checked.

**Owns questions:** what is installed, per-junction cost, compatibility with existing controllers, a junction with no input, who installs it, whether the ambulance needs new hardware. See section 5.5.

---

### P4: Business model (about 70 s)

**Say**
- "Customers: the **municipal corporation** pays. The **signal integrators** building the city's traffic system are our channel. The **ambulance operator** is a data partner. Hospitals are a later extra."
- "Four revenue streams, in the order we can start them: (1) an **evaluation and planning study** run on a city's own network, which needs **no hardware and works today**; (2) a **pilot and integration** project; (3) a **per-junction annual subscription** for hosting, monitoring, updates and safety reports; (4) hardware passed through at a modest margin."
- Honest economics: "Running costs in this category are small per junction (about US$250 a year in one US estimate), so this is **not a one-city business**. It works through many junctions, many cities, and services that do not scale with junction count, like studies and verification."
- "Our moat is **not** the rules. It is the verified safety layer and audit trail, the reproducible evaluation, the integrations and relationships, and later the field data."
- "NMMC is rolling out its own traffic system at 58 junctions. We position as the verified add-on or the independent checker, not a rival."
- Hand-off: "[P5] will show how we get there safely."

**Do not**
- State a price, a market size or a revenue forecast: none has been tested. Say so.
- Promise a purchase.

**Owns questions:** why a city would pay, price, market size, competition, moat, time to revenue, open-source licence.

---

### P5: Feasibility and viability, and the close (about 70 s)

**Say**
- "What is proven: in simulation, 560 runs. What is not: anything on real roads. We say that plainly."
- "We move in **gated stages**. (1) Run the study on a real NMMC corridor with no hardware. (2) Replay recorded ambulance GPS tracks. (3) **Shadow mode**: live positions, our system computes what it would do and logs it, and **nothing is sent to any signal**. (4) A one-corridor pilot with the traffic authority's written approval and the controller's protections on. (5) Scale. We move on only when each gate is met."
- Biggest risks and what we do: the city's own system may already cover this (we will ask for the specification first); approvals and liability (written approval and legal opinion before any live signal); misuse (requests need a registered vehicle and an active dispatch, designed, not yet built); single ambulance only.
- "We have **support**, not a purchase order."
- **The ask:** "Support for the first tranche: the study and shadow mode. Each later tranche is released only at a gate." **[Fill in the figure and use of funds first.]**
- Close in one line: "A verified green for the ambulance, measured before anything is installed."

**Do not**
- Give dates (we give gates), imply field safety, or hide that the team is missing traffic-engineering, legal and procurement experience: name it, with the plan to add it.

**Owns questions:** does it work in the real world, timeline, risks, the NMMC ITMS overlap, government support, team, scaling past one city, what we need from the judges.

---

### Question routing (who answers what)

| If they ask about | Owner | Do not let anyone else improvise |
|---|---|---|
| How it works, safety, "is it AI", simulation validity, abuse, failure, charts | **P2** | Anything algorithmic or about verification |
| What is installed, cost per junction, existing controllers, installation | **P3** | Any hardware price or compatibility claim |
| Money, pricing, market, competition, moat, licence | **P4** | Any figure about revenue |
| Real-world proof, timeline, risks, government, team, ITMS overlap, the ask | **P5** | Any promise of dates or results on real roads |
| Greeting, "what is it", support wording | **P1** | Everything else, pass on |

**If nobody knows:** the whole team uses one line: *"We have not measured that yet. Here is how we would find out:"* and the owner names the stage or the [TO DO].

---

## 12. Questions a judge or investor will ask (and the answers)

Each question is tagged with its **owner** (P1 to P5, section 11). Only the owner answers.

| Question | Answer |
|---|---|
| **[P2] Is this real AI?** | The decision logic is rule-based plus shortest-path routing, and we say that. Rules are auditable, which matters for safety approval. ML for prediction is the roadmap and sits behind the same safety layer; the testbed is how we would prove it helps. |
| **[P5] Does it work in the real world?** | Not yet proven; all numbers are from simulation. That is why the plan starts with shadow mode and a single corridor, with gates. |
| **[P2] Is the simulation even valid?** | It is a standard traffic simulator (SUMO), our baseline is tuned, runs are paired on identical traffic, and we report intervals and p-values. Limits: synthetic grid, cars only, no two-wheelers or pedestrians. Calibrating to Navi Mumbai data is stage 1. |
| **[P5] Isn't NMMC's ITMS already doing green corridors?** | It plans to **[REPORTED]**; we have not seen the specification. We position as a safe, verified add-on or independent checker, and we will request the spec. If it already works well, our value is verification and other cities. |
| **[P3] What do you install?** | Tier A: nothing at the junction. Tier B: one small gateway in the cabinet wired to the controller's own preemption input, with the controller's protections still in charge. Vehicle: the operator's existing GPS if shared, otherwise a 4G tracker. |
| **[P2; hardware failure: P3] What if it fails?** | No position or link → no request → the junction runs its normal program. Software error → controller recovers every junction with full clearance and drops to normal signals. These behaviours are tested in simulation, and field link-loss testing is stage 3. |
| **[P2] Can someone abuse it to get green lights?** | Requests need a registered vehicle *and* an active dispatch from the operator, plus rate limits and logs. **Designed, not built yet.** |
| **[P2] Will it delay other drivers?** | In simulation, not measurably (within ±0.7 %, never significant). The paired design reports the cost next to the benefit. A field pilot must re-measure it. |
| **[P2] Will it cause accidents at the junction?** | The safety layer rejects conflicting greens and enforces 4 s yellow and 2 s all-red; the monitor found 0 violations in 560 runs. The simulator also showed the alternative (crossing red) had ambulance collisions in 12 of 140 runs. In the field, the controller's own conflict monitor stays in force. |
| **[P4] Why would a city pay?** | Evaluation study first: a measured answer for its own network with no hardware. Then a pilot, then a per-junction subscription. **No price has been tested yet.** |
| **[P4] How big is the market?** | We do not have a validated number and will not invent one. Benchmarks suggest thin per-junction revenue (US$250 a year to operate in one US estimate), so the business needs many junctions, many cities or bundled services. |
| **[P4] Why you and not an established vendor?** | We do not claim a better device. We offer verification, reproducible evaluation and low-friction integration. Established vendors have field track records we lack. |
| **[P4] What is your moat?** | Not the rules. The audit trail, the evaluation evidence, integrations and relationships, and later field data. |
| **[P5] Who is on the team and what are you missing?** | **[TO DO: fill in names and roles.]** Honest gaps: field/traffic-engineering experience, legal, and a government-procurement contact. We would add these through advisors or hires. |
| **[P5] Does the government actually support this?** | The project is supported by NMMC (IAS Administration) and acknowledged by the two MLAs named in the paper, and proposed to MMRDA. **That is support, not a purchase order.** Have the letters or emails ready. |
| **[P2] What about two ambulances, buses, trucks, pedestrians?** | Not built or modelled. Multi-vehicle priority is on the roadmap; heavy vehicles need protected-turn phases. |
| **[P5; survey cost: P3] How do you scale past one city?** | The testbed imports a network and runs; the per-junction survey is the bottleneck, and we plan to use the city's own junction data to cut it. **Not yet tested.** |
| **[P4] How long until revenue?** | An evaluation study can start as soon as a city shares network data. Hardware revenue depends on approvals, so we give gates, not dates. |
| **[P4] Is the software open?** | The testbed is built to be open and reproducible; what we sell is the verified field layer, integrations and support. Confirm the licence choice with the team before saying so. **[TO DO]** |
| **[P2] Can you show the numbers again?** | Press **R** in the app, or open `experiments/summary/`. Every run has a manifest with the code version and seed. |
| **[P3] How much does it cost per junction?** | We have no quote yet and will not invent one. The design removes vehicle equipment (if the operator shares its GPS) and detectors, and touches one controller input per cabinet. The US benchmark we must beat is US$4,000 to US$7,225 per junction. We will publish a bill of materials after two real quotes. |
| **[P3] Will it work with the controllers the city already has?** | Unverified. It needs a usable external input on the controller, the same kind emitter systems use. We will check the cabinets of the first three junctions. If a junction has none: use the city's central system, ask the vendor to enable the input, or leave that junction out. |
| **[P3] Could your box turn a signal green on its own, or stick on?** | By design, no. It only closes a contact into the controller's request input and never connects to the lamps; unpowered, it requests nothing. A hardware timer and watchdog drop the request if our software hangs, and the controller's own conflict monitor stays in force. **Designed, not built yet.** |
| **[P3] Does the ambulance need new equipment?** | Not if the operator shares its GPS feed (the new 108 fleet is reported to have one). Otherwise one tracker per pilot ambulance, listed at about ₹3,800 to ₹15,500. |
| **[P3] What if only some junctions on a route are equipped?** | We have not measured that. It is a cheap next experiment in the testbed (preempt at a subset of junctions), and we will run it before claiming a corridor effect. |
| **[P3 and P5] Who installs it, and who is responsible if something fails in the cabinet?** | The city's authorised contractor or vendor, with the city's written approval. Liability is unresolved and needs a legal opinion and insurance before any live signal is touched (stage 4). |
| **[P4] Who is your first customer?** | A municipal corporation, through the no-hardware evaluation study. NMMC is the natural first conversation. That is a conversation, not a commitment. |
| **[P5] What is your biggest risk?** | That the city's own traffic system already covers this, and that approvals and liability slow a pilot. We answer with a specification request to NMMC, the verifier position, gated stages and shadow mode before any live signal. |
| **[P5] What do you need from us?** | Support for the first tranche: the evaluation study on a real corridor and shadow mode. Plus introductions to a municipal traffic engineer, the signal integrator and the ambulance operator. |

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
13. **The controller input is unverified.** The retrofit assumes the installed controllers have a usable external input. *Response:* say "assumption", check three real cabinets first, and fall back to the city's central system or leave a junction out.
14. **Cost-effectiveness is a design claim, not a measured one.** *Response:* the only defensible statement is what we remove (vehicle equipment, detectors); no total is claimed until two quotes exist.

---

## 14. Things to do before presenting (checklist)

- [ ] Open each source in section 15 and confirm the numbers you plan to quote.
- [ ] Ask NMMC for the ITMS green-corridor specification and vendor.
- [ ] Get written confirmation of the NMMC / MLA / MMRDA wording.
- [ ] Fill in the team, roles and the funding ask.
- [ ] Get two or more real hardware quotes (gateway, relay interface, 4G tracker).
- [ ] Look inside the cabinet of at least three real junctions (with the city's permission) and write down which external inputs the controller has.
- [ ] Assign P1 to P5 by name, and let each person rehearse their own section plus the one-sentence version of the other four.
- [ ] Record a backup video of the demo, in case the live run fails on the day.
- [ ] Run the partial-deployment experiment (preempt at only some junctions) so P3 has a measured answer.
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
- AIS-140 tracker price listings (trade listings, ₹3,800 to ₹15,500; vary by certification and seller): <https://www.tradeindia.com/manufacturers/ais-140-gps-tracker.html> and <https://dir.indiamart.com/impcat/ais-140-gps-system.html>
- Maharashtra EMS (official): <https://nhm.maharashtra.gov.in/en/scheme/maharashtra-emergency-medical-services-mems-emergency-medical-service-on-call/>
- Ambulance traffic-rule summaries (secondary; confirm with a lawyer): <https://vmedo.com/blog/traffic-rules-for-ambulances-in-india/> and <https://saferoadlife.in/emergency-vehicles-on-indian-roads-and-exemptions-for-breaking-traffic-rules/>
- Our own results: `experiments/summary/summary.json`, `experiments/summary/paired.csv`, `experiments/summary/collisions.csv`, `paper/emergencyflow.tex`, and `README.md` (Evaluation results).
