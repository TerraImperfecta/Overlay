/* =====================================================================
   3. TIMELINE MERGE
      Boundaries stay in exact milliseconds. Only the GIF path quantises
      to centiseconds, and it carries the rounding error forward.
   ===================================================================== */
export const gcd = (a,b) => { while (b){ [a,b] = [b, a%b]; } return a; };
export const lcm = (a,b) => a / gcd(a,b) * b;

export function effDurations(A,B){
  if (A.static && B.static) return [1000,1000];
  if (A.static) return [B.duration, B.duration];
  if (B.static) return [A.duration, A.duration];
  return [A.duration, B.duration];
}
export function chooseMode(dA,dB,requested){
  if (requested !== "auto") return requested;
  const L = lcm(Math.round(dA), Math.round(dB));
  return (L <= 12000 && L/dA <= 12 && L/dB <= 12) ? "lcm" : "stretch";
}

export function planTimeline(A,B,requested,maxFrames){
  const [dA,dB] = effDurations(A,B);
  const mode = chooseMode(dA,dB,requested);
  let outDur, kA = 1, kB = 1;
  if (mode === "lcm") outDur = Math.min(lcm(Math.round(dA), Math.round(dB)), 60000);
  else if (mode === "stretch"){
    const reps = Math.max(1, Math.round(dA/dB));
    outDur = dA; kB = dA/(dB*reps);
  } else if (mode === "shortest") outDur = Math.min(dA,dB);
  else outDur = Math.max(dA,dB);

  const marks = new Set([0]);
  for (const [g,k] of [[A,kA],[B,kB]]){
    if (g.static) continue;
    const eff = g.duration*k;
    if (!(eff > 0)) continue;
    for (let base = 0; base < outDur; base += eff)
      for (const s of g.starts){
        const t = base + s*k;
        if (t > 0 && t < outDur) marks.add(Math.round(t));
      }
  }
  let times = [...marks].sort((x,y) => x-y);
  const merged = [0];
  for (let i = 1; i < times.length; i++)
    if (times[i] - merged[merged.length-1] >= 20) merged.push(times[i]);
  times = merged;

  let resampled = false;
  if (times.length > maxFrames){
    resampled = true;
    const step = Math.max(20, Math.round(outDur/maxFrames));
    times = [];
    for (let t = 0; t < outDur; t += step) times.push(t);
  }

  const delaysMs = times.map((t,i) => Math.max(20,
    (i+1 < times.length ? times[i+1] : Math.round(outDur)) - t));
  const realTimes = []; let acc = 0;
  for (const d of delaysMs){ realTimes.push(acc); acc += d; }

  const delaysCs = []; let err = 0;
  for (const d of delaysMs){ const v = d + err; const c = Math.max(2, Math.round(v/10));
                             err = v - c*10; delaysCs.push(c); }

  return {mode, outDur:acc, kA, kB, times:realTimes, delaysMs, delaysCs,
          count:delaysMs.length, resampled};
}

export function frameAt(src,t,k){
  if (src.static) return 0;
  let u = (t/k) % src.duration;
  if (u < 0) u += src.duration;
  let lo = 0, hi = src.starts.length-1, r = 0;
  while (lo <= hi){ const m = (lo+hi)>>1;
    if (src.starts[m] <= u){ r = m; lo = m+1; } else hi = m-1; }
  return r;
}
