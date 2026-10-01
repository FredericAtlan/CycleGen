from __future__ import annotations
import json, math, time, sys, csv
from datetime import datetime, timezone
from pathlib import Path
from openpyxl import load_workbook

sys.path.insert(0, str(Path("../scripts").resolve()))
import batch_xspace_avl_compare as batch
from batch_route_studio_here_replay import OUT_DIR, XSPACE_VEHICLE, build_rows, write_xls, write_xlsx
from app.models.schemas import DriverProfile
from app.services.kinematic_solver import IDMSolver

CG = OUT_DIR
PUBLIC = Path("../frontend/public/data")
DL = Path("/Users/fredericatlan/Downloads")
MX = Path("/Volumes/Maximus/AVL Route Studio")
PREA_XLSX = DL / "Grossglokner_XSPACE_PreA.xlsx"
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
now_iso = datetime.now(timezone.utc).isoformat()

# --- sources: 8 RS officiels Maximus ---
RS_PAIRS = [
    ("iseran", "prudent", MX / "XSPACE_descente_Col_de_L_Iseran_conducteur_prudent 1 (1).xls"),
    ("iseran", "dynamique", MX / "XSPACE_descente_Col_de_L_Iseran_conducteur_dynamique 1 (1).xls"),
    ("veleta", "prudent", MX / "XSPACE_Pico_Veleta_vers_Granada_conducteur_prudent (1).xls"),
    ("veleta", "dynamique", MX / "XSPACE_Pico_Veleta_vers_Granada_conducteur_dynamique (1).xls"),
    ("stelvio", "prudent", MX / "XSPACE_Stelvio_conducteur_prudent (1).xls"),
    ("stelvio", "dynamique", MX / "XSPACE_Stelvio_conducteur_dynamique (1).xls"),
    ("grossglockner", "prudent", MX / "XSPACE_Grossglockner_conducteur_prudent.xls"),
    ("grossglockner", "dynamique", MX / "XSPACE_Grossglockner_conducteur_dynamique.xls"),
]
# Mirror RS into OUT_DIR for local reload / HTML paths
import shutil
CG.mkdir(parents=True, exist_ok=True)
for _route, _style, _src in RS_PAIRS:
    if _src.exists():
        dst = CG / _src.name
        if not dst.exists() or dst.stat().st_size != _src.stat().st_size:
            shutil.copy2(_src, dst)
            print(f"copied {_src.name}", flush=True)

ROUTE_LABEL = {
    "iseran": "Col de l'Iseran",
    "veleta": "Pico Veleta",
    "stelvio": "Stelvio",
    "grossglockner": "Großglockner",
}

def clamp(x, lo, hi): return max(lo, min(hi, x))
def mean(xs): return sum(xs)/len(xs) if xs else float("nan")

def fidelity(rmse, dT_pct, da_pos=0.0, da_neg=0.0, da_lat=0.0, osc=0.0):
    s = 100.0
    s -= min(40.0, abs(rmse) * 1.6)
    s -= min(20.0, abs(dT_pct) * 0.35)
    s -= min(10.0, abs(da_pos) * 4)
    s -= min(10.0, abs(da_neg) * 3)
    s -= min(10.0, abs(da_lat) * 2)
    s -= min(15.0, osc * 8)  # penalize HF oscillation
    return round(clamp(s, 0, 100), 1)

def osc_index(v_kmh, s_km):
    """High-frequency speed wiggle: mean |Δ²v| / mean |Δv| on distance."""
    if len(v_kmh) < 10: return 0.0
    dv = [v_kmh[i]-v_kmh[i-1] for i in range(1,len(v_kmh))]
    d2 = [dv[i]-dv[i-1] for i in range(1,len(dv))]
    m1 = mean([abs(x) for x in dv]) or 1e-6
    m2 = mean([abs(x) for x in d2])
    return m2 / m1

def load_prea():
    wb = load_workbook(PREA_XLSX, read_only=True, data_only=True)
    sh = wb[wb.sheetnames[0]]
    rows = list(sh.iter_rows(values_only=True))
    t,vsp,vr,sl=[],[],[],[]
    for r in rows[2:]:
        if not r or r[0] is None: continue
        t.append(float(r[0])); vsp.append(float(r[1])); vr.append(float(r[2])); sl.append(float(r[3]))
    s=[0.0]
    for i in range(1,len(t)):
        dt=t[i]-t[i-1]
        vm=((vr[i]+vr[i-1])/2)/3.6
        s.append(s[-1]+max(0.0,vm)*max(0.0,dt))
    return {"t":t,"vsp":vsp,"vr":vr,"slope":sl,"s":s,"v":[x/3.6 for x in vr]}

def fp_from_raw(raw, style_hint=""):
    a=[0.0]
    for i in range(1,len(raw["t"])):
        dt=raw["t"][i]-raw["t"][i-1]
        a.append((raw["v"][i]-raw["v"][i-1])/dt if dt>1e-6 else 0.0)
    jerk=[0.0]
    for i in range(1,len(a)):
        dt=raw["t"][i]-raw["t"][i-1]
        jerk.append((a[i]-a[i-1])/dt if dt>1e-6 else 0.0)
    a_pos=[x for x in a if x>0.05]; a_neg=[-x for x in a if x<-0.05]
    j_pos=[x for x in jerk if x>0.05]; j_neg=[-x for x in jerk if x<-0.05]
    # use P85 for a_max (less peaky than P95) + P95 for b
    ratios=[]
    for i in range(len(raw["v"])):
        lim = raw.get("lim")
        if lim and lim[i]>15 and raw["v"][i]*3.6>5:
            ratios.append((raw["v"][i]*3.6)/lim[i])
        elif "vsp" in raw and raw["vsp"][i]>15 and raw["vr"][i]>5:
            ratios.append(raw["vr"][i]/raw["vsp"][i])
    a_lat=[]
    if "curv" in raw:
        for i in range(len(raw["v"])):
            c=raw["curv"][i]
            if math.isfinite(c):
                a_lat.append(abs(raw["v"][i]**2*c))
    return {
        "duration_s": raw["t"][-1]-raw["t"][0],
        "distance_m": raw["s"][-1],
        "v_mean_kmh": mean([x*3.6 for x in raw["v"] if x>0.5]),
        "v_max_kmh": max(raw["v"])*3.6,
        "a_pos_p85": batch.pctile(a_pos,85) if a_pos else 1.0,
        "a_pos_p95": batch.pctile(a_pos,95) if a_pos else 1.0,
        "a_neg_p95": batch.pctile(a_neg,95) if a_neg else 1.5,
        "jerk_pos_p85": batch.pctile(j_pos,85) if j_pos else 1.0,
        "jerk_pos_p95": batch.pctile(j_pos,95) if j_pos else 1.5,
        "jerk_neg_p95": batch.pctile(j_neg,95) if j_neg else 2.0,
        "speed_factor_p50": batch.pctile(ratios,50) if ratios else 1.0,
        "speed_factor_p90": batch.pctile(ratios,90) if ratios else 1.0,
        "a_lat_p95": batch.pctile(a_lat,95) if a_lat else 3.0,
        "osc": osc_index([x*3.6 for x in raw["v"]], [x/1000 for x in raw["s"]]),
        "n": len(raw["t"]),
        "style_hint": style_hint,
    }

print("=== 1) Fingerprint 3 drivers (8 RS + PreA) ===", flush=True)
missing = [p for _,_,p in RS_PAIRS if not p.exists()]
if missing:
    raise SystemExit(f"MISSING RS files: {missing}")

fps_prudent=[]; fps_dyn=[]
for route, style, path in RS_PAIRS:
    raw=batch.load_xls(path)
    fp=fp_from_raw(raw, style)
    print(f"  {route}/{style}: vmax={fp['v_max_kmh']:.1f} a+85={fp['a_pos_p85']:.2f} a+95={fp['a_pos_p95']:.2f} sf50={fp['speed_factor_p50']:.3f} sf90={fp['speed_factor_p90']:.3f} osc={fp['osc']:.3f}", flush=True)
    (fps_prudent if style=="prudent" else fps_dyn).append(fp)

prea = load_prea()
prea_raw = {"t":prea["t"],"v":prea["v"],"s":prea["s"],"vsp":prea["vsp"],"vr":prea["vr"],"slope":prea["slope"]}
fp_prea = fp_from_raw(prea_raw, "prea")
print(f"  prea: vmax={fp_prea['v_max_kmh']:.1f} a+85={fp_prea['a_pos_p85']:.2f} sf50={fp_prea['speed_factor_p50']:.3f} sf90={fp_prea['speed_factor_p90']:.3f} osc={fp_prea['osc']:.3f}", flush=True)

def tracking_sf(fps):
    """P50 v/lim biaisé bas en descente → utiliser P90, clamp [0.95, 1.15]."""
    p50 = mean([f["speed_factor_p50"] for f in fps])
    p90 = mean([f["speed_factor_p90"] for f in fps])
    return round(clamp(max(p50, p90 * 0.92, 0.98), 0.95, 1.15), 3)

def agg_driver(fps, name, base, T, T_h, s0, pedal, vdes, hold):
    return {
        "id": f"route-studio-{name}" if name!="prea" else "xspace-prea-grossglockner",
        "name": f"Route_Studio_{name.capitalize()}" if name!="prea" else "XSPACE_PreA_Grossglockner",
        "baseProfile": base,
        "a_y": round(mean([f["a_lat_p95"] for f in fps]), 3),
        "physics": {
            "a_max": round(mean([f["a_pos_p85"] for f in fps]), 3),
            "b_comf": round(mean([f["a_neg_p95"] for f in fps]), 3),
            "speed_factor": tracking_sf(fps),
            "T": T, "T_h": T_h, "s0": s0,
            "jerk_max": round(mean([f["jerk_pos_p85"] for f in fps]), 3),
            "jerk_brake_max": round(mean([f["jerk_neg_p95"] for f in fps]), 3),
            "pedal_tau_s": pedal,
            "vdes_tau_s": vdes,
            "descent_hold_gain": hold,
        },
        "notes": f"Re-ID {stamp} · 8 RS Maximus · pedal lag · n={len(fps)}",
        "updatedAt": now_iso,
        "seed": True,
    }

drv_prudent = agg_driver(fps_prudent, "prudent", "Prudent", 1.8, 4.5, 2.8, 0.55, 0.80, 0.40)
drv_dyn = agg_driver(fps_dyn, "dynamique", "Dynamique", 1.2, 3.0, 1.8, 0.40, 0.50, 0.28)
drv_prea = {
    "id": "xspace-prea-grossglockner",
    "name": "XSPACE_PreA_Grossglockner",
    "baseProfile": "Dynamique",
    "a_y": round(clamp(fp_prea["a_lat_p95"] if fp_prea["a_lat_p95"]>1 else 6.5, 3.0, 8.5), 3),
    "physics": {
        "a_max": round(fp_prea["a_pos_p85"], 3),
        "b_comf": round(fp_prea["a_neg_p95"], 3),
        "speed_factor": round(clamp(max(fp_prea["speed_factor_p50"], fp_prea["speed_factor_p90"]*0.92, 0.98), 0.95, 1.15), 3),
        "T": 1.4, "T_h": 3.5, "s0": 2.0,
        "jerk_max": round(fp_prea["jerk_pos_p85"], 3),
        "jerk_brake_max": round(fp_prea["jerk_neg_p95"], 3),
        "pedal_tau_s": 0.48,
        "vdes_tau_s": 0.65,
        "descent_hold_gain": 0.32,
    },
    "notes": f"Re-ID PreA {stamp} · pedal lag + descent hold",
    "updatedAt": now_iso,
    "seed": True,
}
drv_prea["a_y"] = 6.5  # refined on Glock RS geom later

print("  drivers:", {d["name"]: d["physics"] for d in (drv_prudent, drv_dyn, drv_prea)}, flush=True)

DRIVERS = {"prudent": drv_prudent, "dynamique": drv_dyn, "prea": drv_prea}

def series_ds(s, max_n=1200):
    n=len(s["t"]); step=max(1,n//max_n); idx=list(range(0,n,step))
    if idx[-1]!=n-1: idx.append(n-1)
    a=[0.0]
    for i in range(1,n):
        dt=s["t"][i]-s["t"][i-1]
        a.append((s["v"][i]-s["v"][i-1])/dt if dt>1e-6 else 0.0)
    while len(a)<n: a.append(0.0)
    return {
        "s_km":[round(s["s"][i]/1000,4) for i in idx],
        "v_kmh":[round(s["v"][i]*3.6,2) for i in idx],
        "a":[round(a[i],4) for i in idx],
        "slope":[round(s["slope"][i],2) if ("slope" in s and math.isfinite(s["slope"][i])) else None for i in idx],
        "alt":[round(s["alt"][i],1) if ("alt" in s and math.isfinite(s["alt"][i])) else None for i in idx],
        "lim":[round(s["lim"][i],1) if ("lim" in s and math.isfinite(s["lim"][i])) else None for i in idx],
    }

def cg_fp(prof, corridor, overrides, a_y):
    from app.services.curvature import curvature_radius_m
    v=list(prof.velocity); s=list(prof.position); a=list(prof.acceleration)
    a_pos=[x for x in a if x>0.05]; a_neg=[-x for x in a if x<-0.05]
    R=curvature_radius_m(list(corridor.geometry)); S=list(corridor.S)
    a_lat=[]
    for i in range(0,len(s), max(1,len(s)//800)):
        sm=s[i]; lo,hi=0,len(S)-1
        while hi-lo>1:
            mid=(lo+hi)//2
            if S[mid]<=sm: lo=mid
            else: hi=mid
        r=R[lo]
        if math.isfinite(r) and 5<r<2000: a_lat.append(v[i]**2/r)
    return {
        "duration_s": prof.total_duration_s, "distance_m": s[-1],
        "v_mean_kmh": prof.average_speed_kmh, "v_max_kmh": max(v)*3.6,
        "a_pos_p95": batch.pctile(a_pos,95) if a_pos else 0.0,
        "a_neg_p95": batch.pctile(a_neg,95) if a_neg else 0.0,
        "a_lat_p95": batch.pctile(a_lat,95) if a_lat else a_y,
        "speed_factor_p90": overrides.get("speed_factor",1.0),
        "osc": osc_index([x*3.6 for x in v], [x/1000 for x in s]),
        "n": len(v),
    }

def aligned_series(rs_s, rs_v, cg_s, cg_v, n=900):
    L=rs_s[-1]
    grid=[i*L/(n-1) for i in range(n)]
    v_rs=batch.resample_on_s(rs_s, [x*3.6 for x in rs_v], grid)
    v_cg=batch.resample_on_s(cg_s, [x*3.6 for x in cg_v], grid)
    return {
        "s_km":[round(x/1000,4) for x in grid],
        "v_rs":[round(x,2) for x in v_rs],
        "v_cg":[round(x,2) for x in v_cg],
        "err":[round(a-b,2) for a,b in zip(v_cg,v_rs)],
    }

def run_arm(ds, style_key, drv, variant, fp_rs):
    phys=dict(drv["physics"])
    base = DriverProfile.PRUDENT if style_key=="prudent" else DriverProfile.DYNAMIQUE
    ay_g=float(drv["a_y"]); ay_r=float(fp_rs.get("a_lat_p95") or ay_g)
    sf_r=float(fp_rs.get("speed_factor_p90") or phys["speed_factor"])
    overrides={k:float(phys[k]) for k in phys}
    zone_ay=True; hair=1.35; a_y=ay_g
    if variant=="geom_global":
        a_y=ay_g
    elif variant=="geom_ay_route":
        a_y=ay_r
    elif variant=="geom_ay_sf":
        a_y=ay_r; overrides["speed_factor"]=sf_r
    elif variant=="geom_full":
        a_y=ay_r
        overrides.update({"a_max":float(fp_rs["a_pos_p85"]),"b_comf":float(fp_rs["a_neg_p95"]),
            "jerk_max":float(fp_rs["jerk_pos_p85"]),"jerk_brake_max":float(fp_rs["jerk_neg_p95"]),
            "speed_factor":sf_r})
    elif variant=="geom_soft_pedal":
        a_y=ay_r; overrides["pedal_tau_s"]=overrides.get("pedal_tau_s",0.5)*1.25
        overrides["vdes_tau_s"]=overrides.get("vdes_tau_s",0.6)*1.2
        overrides["speed_factor"]=sf_r
    elif variant=="geom_full_soft":
        a_y=ay_r
        overrides.update({"a_max":float(fp_rs["a_pos_p85"]),"b_comf":float(fp_rs["a_neg_p95"]),
            "jerk_max":float(fp_rs["jerk_pos_p85"]),"jerk_brake_max":float(fp_rs["jerk_neg_p95"]),
            "speed_factor":sf_r, "pedal_tau_s":overrides.get("pedal_tau_s",0.5)*1.3,
            "descent_hold_gain":overrides.get("descent_hold_gain",0.3)*1.2})
    else:
        raise ValueError(variant)
    t0=time.time()
    corr=batch.synth_corridor(ds, a_y=a_y, zone_ay=zone_ay, a_y_hairpin=a_y*hair)
    prof=IDMSolver(corr, base, seed=42, max_speed_mps=130/3.6, enable_markov=False,
                   param_overrides=overrides, vehicle=XSPACE_VEHICLE).solve()
    sc=batch.score_vs_avl(prof, ds["s"], ds["v"], fp_rs["duration_s"])
    cfp=cg_fp(prof, corr, overrides, a_y)
    score=fidelity(sc["rmse_v_kmh"], sc["delta_duration_pct"],
                   cfp["a_pos_p95"]-fp_rs.get("a_pos_p95",cfp["a_pos_p95"]),
                   cfp["a_neg_p95"]-fp_rs.get("a_neg_p95",cfp["a_neg_p95"]),
                   cfp["a_lat_p95"]-fp_rs.get("a_lat_p95",a_y),
                   osc=cfp["osc"])
    return {
        "variant":variant,"params":{**overrides,"a_y":a_y},"a_y":a_y,
        "rmse_v_kmh":sc["rmse_v_kmh"],"mae_v_kmh":sc["mae_v_kmh"],"bias_v_kmh":sc["bias_v_kmh"],
        "corr_v":sc["corr_v"],"duration_s":sc["duration_s"],"delta_duration_pct":sc["delta_duration_pct"],
        "score":score,"osc":cfp["osc"],"elapsed_s":round(time.time()-t0,2),
        "_prof":prof,"_corr":corr,"_cfp":cfp,"_sc":sc,
    }

VARIANTS=["geom_global","geom_ay_route","geom_ay_sf","geom_full","geom_soft_pedal","geom_full_soft"]

print("\n=== 2) Geometry-lock fit (8 RS) ===", flush=True)
comparisons=[]; fit_log=[]
all_raw_pairs=[]  # (route, style, raw, rs_file)

for route, style, path in RS_PAIRS:
    raw = batch.load_xls(path)
    fp = fp_from_raw(raw, style)
    ds = batch.downsample(raw, max_n=3000)
    drv = DRIVERS[style]
    print(f"\n--- {route}/{style} ---", flush=True)
    arms=[]
    for var in VARIANTS:
        print(f"  → {var}…", flush=True)
        arm=run_arm(ds, style, drv, var, fp)
        print(f"     RMSE={arm['rmse_v_kmh']} osc={arm['osc']:.3f} score={arm['score']} ΔT%={arm['delta_duration_pct']}", flush=True)
        arms.append(arm)
    # best by composite: prefer lower rmse, then lower osc
    best=min(arms, key=lambda a: (a["rmse_v_kmh"] + 4*a["osc"], -a["score"]))
    print(f"  BEST {best['variant']} RMSE={best['rmse_v_kmh']} osc={best['osc']:.3f}", flush=True)

    rows=build_rows(best["_prof"], best["_corr"], XSPACE_VEHICLE)
    stem=f"CycleGen_FIT_{route}_Route_Studio_{style.capitalize()}_{stamp}"
    write_xls(CG/f"{stem}.xls", rows, f"CG_{route}_{style}"[:31])
    write_xlsx(CG/f"{stem}.xlsx", rows, f"CG_{route}_{style}"[:31])
    latest=f"CycleGen_FIT_{route}_Route_Studio_{style.capitalize()}_latest.xls"
    write_xls(CG/latest, rows, f"CG_{route}_{style}"[:31])
    # CSV export
    csv_path=CG/f"{stem}.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w=csv.writer(f)
        w.writerow(["t_s","s_m","v_kmh","a_mps2","slope_pct","alt_m","lat","lon"])
        for r in rows:
            # build_rows format — inspect first
            pass
    cg_raw=batch.load_xls(CG/latest)
    # write proper csv from loaded
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w=csv.writer(f)
        w.writerow(["t_s","s_m","v_kmh","a_mps2","slope_pct","alt_m","lat","lon","spd_lim_kmh"])
        aa=[0.0]
        for i in range(1,len(cg_raw["t"])):
            dt=cg_raw["t"][i]-cg_raw["t"][i-1]
            aa.append((cg_raw["v"][i]-cg_raw["v"][i-1])/dt if dt>1e-6 else 0.0)
        step=max(1,len(cg_raw["t"])//4000)
        for i in range(0,len(cg_raw["t"]),step):
            w.writerow([
                round(cg_raw["t"][i],3), round(cg_raw["s"][i],2), round(cg_raw["v"][i]*3.6,3),
                round(aa[i],4), round(cg_raw["slope"][i],3) if math.isfinite(cg_raw["slope"][i]) else "",
                round(cg_raw["alt"][i],2) if math.isfinite(cg_raw["alt"][i]) else "",
                cg_raw["lat"][i], cg_raw["lon"][i],
                round(cg_raw["lim"][i],2) if math.isfinite(cg_raw["lim"][i]) else "",
            ])

    al=aligned_series(raw["s"], raw["v"], list(best["_prof"].position), list(best["_prof"].velocity))
    cfp=best["_cfp"]
    compare={
        "aligned":al,"rmse_v_kmh":best["rmse_v_kmh"],"mae_v_kmh":best["mae_v_kmh"],
        "bias_v_kmh":best["bias_v_kmh"],"corr_v":best["corr_v"],
        "delta_duration_pct":best["delta_duration_pct"],
        "delta_duration_s":round(best["duration_s"]-fp["duration_s"],1),
        "delta_v_mean_kmh":round(cfp["v_mean_kmh"]-fp["v_mean_kmh"],2),
        "delta_distance_m":round(cfp["distance_m"]-fp["distance_m"],1),
        "delta_a_pos_p95":round(cfp["a_pos_p95"]-fp["a_pos_p95"],3),
        "delta_a_neg_p95":round(cfp["a_neg_p95"]-fp["a_neg_p95"],3),
        "delta_a_lat_p95":round(cfp["a_lat_p95"]-fp["a_lat_p95"],3),
        "delta_speed_factor_p90":round(cfp["speed_factor_p90"]-fp["speed_factor_p90"],3),
        "fidelity_score":best["score"],"method":best["variant"],"params":best["params"],
        "osc_rs":fp["osc"],"osc_cg":cfp["osc"],
    }
    rs_file = path.name
    entry={
        "route":route,"route_label":ROUTE_LABEL[route],"style":style,
        "rs_file":rs_file,"cg_file":f"{stem}.xls","cg_file_latest":latest,
        "cg_csv":csv_path.name,
        "rs_fp":{k:v for k,v in fp.items() if k!="style_hint"},
        "cg_fp":cfp,"rs_series":series_ds(raw),"cg_series":series_ds(cg_raw),
        "rs_energy":0,"cg_energy":0,"compare":compare,
        "all_arms":[{k:v for k,v in a.items() if not k.startswith("_")} for a in arms],
    }
    comparisons.append(entry)
    fit_log.append({"route":route,"style":style,"best":{k:v for k,v in best.items() if not k.startswith("_")},
                    "arms":[{k:v for k,v in a.items() if not k.startswith("_")} for a in arms]})
    all_raw_pairs.append((route,style,raw,best))

# --- 3) Grossglockner PreA driver on RS geometry vs PreA official ---
print("\n=== 3) Glock PreA driver on RS geom ===", flush=True)
rs_glock = batch.load_xls(MX / "XSPACE_Grossglockner_conducteur_dynamique.xls")
# refine PreA a_y from RS curv × PreA speeds mapped
from app.services.curvature import curvature_radius_m
from app.models.schemas import LatLon
geom=[LatLon(lat=rs_glock["lat"][i], lon=rs_glock["lon"][i]) for i in range(len(rs_glock["s"]))]
R=curvature_radius_m(geom)
scale=rs_glock["s"][-1]/max(prea["s"][-1],1)
a_lat=[]
for i in range(0,len(prea["s"]), max(1,len(prea["s"])//800)):
    sm=prea["s"][i]*scale
    lo,hi=0,len(rs_glock["s"])-1
    while hi-lo>1:
        mid=(lo+hi)//2
        if rs_glock["s"][mid]<=sm: lo=mid
        else: hi=mid
    r=R[lo]
    if math.isfinite(r) and 5<r<500: a_lat.append(prea["v"][i]**2/r)
drv_prea["a_y"]=round(clamp(batch.pctile(a_lat,95) if a_lat else 6.5, 3.0, 8.5),3)
DRIVERS["prea"]=drv_prea
print(f"  PreA a_y={drv_prea['a_y']}", flush=True)

# Build corridor from RS + optionally blend PreA v_sp into lim softly
ds_g = batch.downsample(rs_glock, max_n=3000)
# map PreA v_sp onto RS s for a hybrid envelope variant
prea_s_on = [(s/ds_g["s"][-1])*prea["s"][-1] for s in ds_g["s"]]
vsp_m = batch.resample_on_s(prea["s"], prea["vsp"], prea_s_on)
ds_prea_env = dict(ds_g)
# soft blend: max(RS lim, 0.9*PreA vsp) capped 100 — helps PreA driver track official
ds_prea_env["lim"]=[max(ds_g["lim"][i] if math.isfinite(ds_g["lim"][i]) else 0, min(100.0, 0.92*vsp_m[i])) for i in range(len(ds_g["s"]))]
# use PreA slope mapped
sl_m = batch.resample_on_s(prea["s"], prea["slope"], prea_s_on)
ds_prea_env["slope"]=sl_m

fp_prea_ref = fp_from_raw(prea_raw, "prea")
# For scoring vs PreA, build a synthetic ds with PreA v on RS s
ds_score = dict(ds_prea_env)
ds_score["v"]=batch.resample_on_s(prea["s"], prea["v"], prea_s_on)
ds_score["t"]=list(ds_g["t"])  # rough
# better duration from prea
fp_score={**fp_prea_ref, "duration_s":fp_prea["duration_s"], "a_lat_p95":drv_prea["a_y"]}

arms_p=[]
for var in VARIANTS:
    print(f"  → prea/{var}…", flush=True)
    arm=run_arm(ds_prea_env, "prea", drv_prea, var, fp_score)
    # rescore vs PreA velocity on normalized distance
    Lref=prea["s"][-1]; n=500
    grid=[i*Lref/(n-1) for i in range(n)]
    vref=batch.resample_on_s(prea["s"], prea["vr"], grid)
    Lcg=arm["_prof"].position[-1]
    gridcg=[i*Lcg/(n-1) for i in range(n)]
    vcg=batch.resample_on_s(list(arm["_prof"].position), [x*3.6 for x in arm["_prof"].velocity], gridcg)
    err=[(a-b)**2 for a,b in zip(vcg,vref)]
    rmse=math.sqrt(mean(err))
    arm["rmse_v_kmh"]=round(rmse,2)
    arm["score"]=fidelity(rmse, 100*(arm["duration_s"]-fp_prea["duration_s"])/fp_prea["duration_s"], osc=arm["osc"])
    print(f"     vsPreA RMSE={arm['rmse_v_kmh']} osc={arm['osc']:.3f} score={arm['score']}", flush=True)
    arms_p.append(arm)
best_p=min(arms_p, key=lambda a: (a["rmse_v_kmh"]+4*a["osc"], -a["score"]))
print(f"  BEST prea {best_p['variant']} RMSE={best_p['rmse_v_kmh']}", flush=True)

rows=build_rows(best_p["_prof"], best_p["_corr"], XSPACE_VEHICLE)
stem=f"CycleGen_FIT_grossglockner_XSPACE_PreA_{stamp}"
write_xls(CG/f"{stem}.xls", rows, "CG_glock_prea")
write_xlsx(CG/f"{stem}.xlsx", rows, "CG_glock_prea")
latest="CycleGen_FIT_grossglockner_XSPACE_PreA_latest.xls"
write_xls(CG/latest, rows, "CG_glock_prea")
cg_raw=batch.load_xls(CG/latest)
csv_path=CG/f"{stem}.csv"
with csv_path.open("w", newline="", encoding="utf-8") as f:
    w=csv.writer(f); w.writerow(["t_s","s_m","v_kmh","slope_pct","alt_m","lat","lon"])
    step=max(1,len(cg_raw["t"])//4000)
    for i in range(0,len(cg_raw["t"]),step):
        w.writerow([round(cg_raw["t"][i],3),round(cg_raw["s"][i],2),round(cg_raw["v"][i]*3.6,3),
                    round(cg_raw["slope"][i],3) if math.isfinite(cg_raw["slope"][i]) else "",
                    round(cg_raw["alt"][i],2) if math.isfinite(cg_raw["alt"][i]) else "",
                    cg_raw["lat"][i], cg_raw["lon"][i]])

# PreA series for HTML
step=max(1,len(prea["t"])//1500); idx=list(range(0,len(prea["t"]),step))
if idx[-1]!=len(prea["t"])-1: idx.append(len(prea["t"])-1)
prea_series={"s_km":[round(prea["s"][i]/1000,4) for i in idx],"v_kmh":[round(prea["vr"][i],2) for i in idx],
             "vsp_kmh":[round(prea["vsp"][i],2) for i in idx],"slope":[round(prea["slope"][i],2) for i in idx],
             "t":[round(prea["t"][i],3) for i in idx]}

# aligned prea vs cg
n=500; Lref=prea["s"][-1]; grid=[i*Lref/(n-1) for i in range(n)]
vref=batch.resample_on_s(prea["s"], prea["vr"], grid)
Lcg=best_p["_prof"].position[-1]; gridcg=[i*Lcg/(n-1) for i in range(n)]
vcg=batch.resample_on_s(list(best_p["_prof"].position),[x*3.6 for x in best_p["_prof"].velocity],gridcg)
al_prea={"u":[i/(n-1) for i in range(n)],"v_ref":[round(x,2) for x in vref],"v_cg":[round(x,2) for x in vcg],
         "err":[round(a-b,2) for a,b in zip(vcg,vref)]}

cfp=best_p["_cfp"]
prea_entry={
    "route":"grossglockner","route_label":"Großglockner","style":"prea",
    "rs_file":PREA_XLSX.name,"cg_file":f"{stem}.xls","cg_file_latest":latest,"cg_csv":csv_path.name,
    "rs_fp":fp_prea,"cg_fp":cfp,
    "rs_series":prea_series,"cg_series":series_ds(cg_raw),
    "rs_energy":0,"cg_energy":0,
    "compare":{
        "aligned":{"s_km":[round(u*Lref/1000,4) for u in al_prea["u"]],"v_rs":al_prea["v_ref"],"v_cg":al_prea["v_cg"],"err":al_prea["err"]},
        "rmse_v_kmh":best_p["rmse_v_kmh"],"mae_v_kmh":best_p["mae_v_kmh"],"bias_v_kmh":best_p["bias_v_kmh"],
        "corr_v":best_p["corr_v"],"delta_duration_pct":round(100*(best_p["duration_s"]-fp_prea["duration_s"])/fp_prea["duration_s"],2),
        "delta_duration_s":round(best_p["duration_s"]-fp_prea["duration_s"],1),
        "delta_v_mean_kmh":round(cfp["v_mean_kmh"]-fp_prea["v_mean_kmh"],2),
        "delta_distance_m":round(cfp["distance_m"]-fp_prea["distance_m"],1),
        "delta_a_pos_p95":round(cfp["a_pos_p95"]-fp_prea["a_pos_p95"],3),
        "delta_a_neg_p95":round(cfp["a_neg_p95"]-fp_prea["a_neg_p95"],3),
        "delta_a_lat_p95":0.0,"delta_speed_factor_p90":0.0,
        "fidelity_score":best_p["score"],"method":best_p["variant"],"params":best_p["params"],
        "osc_rs":fp_prea["osc"],"osc_cg":cfp["osc"],
    },
    "all_arms":[{k:v for k,v in a.items() if not k.startswith("_")} for a in arms_p],
}
comparisons.append(prea_entry)
fit_log.append({"route":"grossglockner","style":"prea","best":{k:v for k,v in best_p.items() if not k.startswith("_")},
                "arms":[{k:v for k,v in a.items() if not k.startswith("_")} for a in arms_p]})

# summary
fids=[c["compare"]["fidelity_score"] for c in comparisons]
rmses=[c["compare"]["rmse_v_kmh"] for c in comparisons]
oscs=[c["compare"].get("osc_cg",0) for c in comparisons]
bestp=max(comparisons,key=lambda c:c["compare"]["fidelity_score"])
worstp=min(comparisons,key=lambda c:c["compare"]["fidelity_score"])
by_style={}; by_route={}
for st in ("prudent","dynamique","prea"):
    sub=[c for c in comparisons if c["style"]==st]
    if not sub: continue
    by_style[st]={"fidelity":round(mean([c["compare"]["fidelity_score"] for c in sub]),2),
                  "rmse":round(mean([c["compare"]["rmse_v_kmh"] for c in sub]),2),
                  "osc":round(mean([c["compare"].get("osc_cg",0) for c in sub]),3),
                  "delta_T_pct":round(mean([c["compare"]["delta_duration_pct"] for c in sub]),2)}
for rt in sorted({c["route"] for c in comparisons}):
    sub=[c for c in comparisons if c["route"]==rt]
    by_route[rt]={"fidelity":round(mean([c["compare"]["fidelity_score"] for c in sub]),2),
                  "rmse":round(mean([c["compare"]["rmse_v_kmh"] for c in sub]),2),
                  "delta_dist_m":round(mean([c["compare"]["delta_distance_m"] for c in sub]),1)}

summary={
    "generated_at":now_iso,"mode":"maximus_8rs_pedal_lag_3drivers",
    "n_pairs":len(comparisons),"fidelity_mean":round(mean(fids),2),
    "fidelity_min":min(fids),"fidelity_max":max(fids),
    "rmse_mean":round(mean(rmses),2),"rmse_best":min(rmses),"rmse_worst":max(rmses),
    "osc_mean":round(mean(oscs),3),
    "best_pair":{"route":bestp["route"],"style":bestp["style"],"score":bestp["compare"]["fidelity_score"],
                 "rmse":bestp["compare"]["rmse_v_kmh"],"method":bestp["compare"]["method"]},
    "worst_pair":{"route":worstp["route"],"style":worstp["style"],"score":worstp["compare"]["fidelity_score"],
                  "rmse":worstp["compare"]["rmse_v_kmh"],"method":worstp["compare"]["method"]},
    "by_style":by_style,"by_route":by_route,
    "model_upgrades":["pedal_tau_s","vdes_tau_s","descent_hold_gain","a_max/jerk P85","sf from P90 tracking","8 RS Maximus incl Iseran prudent"],
    "sources":[str(p) for _,_,p in RS_PAIRS]+[str(PREA_XLSX)],
}

payload={
    "generated_at":now_iso,"summary":summary,"comparisons":comparisons,"fit_log":fit_log,
    "drivers":{
        "route-studio-prudent":drv_prudent,
        "route-studio-dynamique":drv_dyn,
        "xspace-prea-grossglockner":drv_prea,
    },
    "grossglockner":{
        "mode":"geometry_lock_3_drivers","stamp":stamp,
        "prea_file":PREA_XLSX.name,"prea_series":prea_series,"prea_fp":fp_prea,
        "aligned_prea":al_prea,
        "geometry_lock":{c["style"]:{"rmse":c["compare"]["rmse_v_kmh"],"score":c["compare"]["fidelity_score"],
                         "method":c["compare"]["method"],"file":c["cg_file"],"osc":c["compare"].get("osc_cg")}
                         for c in comparisons if c["route"]=="grossglockner"},
        "rs_avl_available":True,
        "rs_files":{"prudent":"XSPACE_Grossglockner_conducteur_prudent.xls",
                    "dynamique":"XSPACE_Grossglockner_conducteur_dynamique.xls",
                    "prea":PREA_XLSX.name},
        "laius":{
            "title":"Modèle conducteur : lag pédale + retenue descente + re-ID ×3",
            "problem":"Les profils CG oscillaient plus que RS (tracker IDM raide sans dynamique de pédale).",
            "adaptations":[
                "pedal_tau_s : filtre 1er ordre sur a_cmd (pied/actionneur)",
                "vdes_tau_s : low-pass sur consigne vitesse",
                "descent_hold_gain : retenue continue en descente près de v_des",
                "Re-fingerprint a_max/jerk sur P85 (moins de pics HF)",
                "3 conducteurs : Prudent, Dynamique, PreA Grossglockner",
            ],
        },
    },
    "recommendations":PREV.get("recommendations",[]),
}
(CG/"avl_vs_cyclegen_compare_data.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
(CG/f"fit_summary_pedal_{stamp}.json").write_text(json.dumps({"summary":summary,"fit_log":fit_log,"drivers":payload["drivers"]}, ensure_ascii=False), encoding="utf-8")
(CG/"fit_summary_latest.json").write_text(json.dumps({"summary":summary,"fit_log":fit_log,"drivers":payload["drivers"]}, ensure_ascii=False), encoding="utf-8")

# update pack
pack=json.loads((PUBLIC/"route_studio_fit_pack.json").read_text())
byd={d["id"]:d for d in pack["drivers"]}
for d in (drv_prudent, drv_dyn, drv_prea):
    byd[d["id"]]=d
pack["drivers"]=list(byd.values())
pack["updated_at"]=now_iso
pack["grossglockner_rs"]={"stamp":stamp,"fit":payload["grossglockner"]["geometry_lock"]}
# refresh key cycles lightly (ids)
byc={c["id"]:c for c in pack["cycles"]}
for c in comparisons:
    cid=f"rs_fit_{c['route']}_{c['style']}"
    # keep minimal pointer meta; full series already large — update stats/meta
    byc[cid]={
        "id":cid,
        "name":f"FIT · {c['route_label']} · {c['style']}",
        "savedAt":now_iso,"source":f"CycleGen · {c['compare']['method']} · pedal-lag",
        "origin":"cyclegen","resultAvailable":True,
        "stats":{"duration_s":c["cg_fp"]["duration_s"],"distance_m":c["cg_fp"]["distance_m"],
                 "v_mean_kmh":c["cg_fp"]["v_mean_kmh"],"v_max_kmh":c["cg_fp"]["v_max_kmh"]},
        "time":c["cg_series"]["s_km"] and c["cg_series"].get("t") or [],
        # store series from cg_series rebuilt
        **{k:c["cg_series"].get(k) for k in ()},
        "meta":{"driverId": DRIVERS[c["style"]]["id"],"driverName":DRIVERS[c["style"]]["name"],
                "aY":c["compare"]["params"].get("a_y"),"physics":{k:c["compare"]["params"].get(k) for k in DRIVERS[c["style"]]["physics"]},
                "notes":f"RMSE {c['compare']['rmse_v_kmh']} · osc {c['compare'].get('osc_cg')} · {c['compare']['method']}"},
    }
    # attach series properly
    s=batch.load_xls(CG/c["cg_file_latest"])
    n=len(s["t"]); step=max(1,n//2500); idx=list(range(0,n,step))
    if idx[-1]!=n-1: idx.append(n-1)
    aa=[0.0]
    for i in range(1,n):
        dt=s["t"][i]-s["t"][i-1]; aa.append((s["v"][i]-s["v"][i-1])/dt if dt>1e-6 else 0.0)
    while len(aa)<n: aa.append(0.0)
    byc[cid].update({
        "time":[round(s["t"][i],3) for i in idx],
        "velocity":[round(s["v"][i],4) for i in idx],
        "acceleration":[round(aa[i],4) for i in idx],
        "position":[round(s["s"][i],3) for i in idx],
        "slope":[round(math.atan(s["slope"][i]/100),5) if math.isfinite(s["slope"][i]) else 0.0 for i in idx],
    })
pack["cycles"]=list(byc.values())
for path in (PUBLIC/"route_studio_fit_pack.json", CG/"route_studio_fit_pack.json"):
    path.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
# drivers json for frontend
(PUBLIC/"route_studio_drivers.json").write_text(json.dumps({"drivers":[drv_prudent,drv_dyn,drv_prea],"updated_at":now_iso}, ensure_ascii=False), encoding="utf-8")

print("\nDONE refit", flush=True)
print(json.dumps({"summary":summary,"glock":payload["grossglockner"]["geometry_lock"],"drivers":{k:v["physics"] for k,v in DRIVERS.items()}}, indent=2), flush=True)