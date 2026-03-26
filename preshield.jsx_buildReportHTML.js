  const buildReportHTML = (project, t, forPrint = false) => {
    const risks = project.risks || [];
    const sorted = [...risks].sort((a, b) => b.risk_score - a.risk_score);
    const scoreColor = project.overall_risk_score >= 60 ? "#E24B4A" : project.overall_risk_score >= 30 ? "#EF9F27" : "#1D9E75";
    const riskColor = (s) => s >= 18 ? "#E53935" : s >= 12 ? "#F57C00" : s >= 6 ? "#EF9F27" : "#1D9E75";
    
    // Matrix constants matching MatrixView
    const PLOT_W = 720;
    const PLOT_H = 480;
    const PAD_LEFT = 52;
    const PAD_TOP = 58;
    const PAD_RIGHT = 40;
    const PAD_BOTTOM = 44;
    const innerW = PLOT_W - PAD_LEFT - PAD_RIGHT;
    const innerH = PLOT_H - PAD_TOP - PAD_BOTTOM;
    const cellW = innerW / 5;
    const cellH = innerH / 5;
    const cellInset = 1.5;
    const cellRx = 10;
    
    const toX = (impact) => PAD_LEFT + ((parseFloat(impact) - 1) / 4) * innerW;
    const toY = (likelihood) => PAD_TOP + ((5 - parseFloat(likelihood)) / 4) * innerH;

    const matrixZoneFill = (I, L) => {
      const p = (I * L) / 25;
      if (p < 0.12) return "#E8F5E9";
      if (p < 0.28) return "#FFE9B5";
      if (p < 0.5) return "#FFE0B2";
      return "#FFEBEE";
    };

    const matrixCells = [];
    for (let L = 1; L <= 5; L++) {
      for (let I = 1; I <= 5; I++) {
        const x0 = PAD_LEFT + (I - 1) * cellW;
        const y0 = PAD_TOP + (5 - L) * cellH;
        matrixCells.push(`<rect x="${x0 + cellInset}" y="${y0 + cellInset}" width="${cellW - 2 * cellInset}" height="${cellH - 2 * cellInset}" rx="${cellRx}" ry="${cellRx}" fill="${matrixZoneFill(I, L)}" stroke="rgba(0,0,0,0.07)" stroke-width="1" />`);
      }
    }

    const matrixDots = sorted.map((r, idx) => {
      const impact = Math.min(5, Math.max(1, parseFloat(r.impact || 3)));
      const likelihood = Math.min(5, Math.max(1, parseFloat(r.likelihood || 3)));
      const cx = toX(impact);
      const cy = toY(likelihood);
      const color = riskColor(r.risk_score);
      return `
        <g>
          <circle cx="${cx}" cy="${cy}" r="17" fill="${color}" stroke="#fff" stroke-width="2" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));" />
          <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="800" fill="#fff">#${idx + 1}</text>
        </g>
      `;
    }).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PreShield Report — ${project.name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; background: #fff; font-size: 14px; line-height: 1.65; }
  .page { max-width: 780px; margin: 0 auto; padding: ${forPrint ? "20px" : "40px 32px"}; }
  .matrix-container { margin: 32px 0; border: 1px solid #eee; border-radius: 12px; padding: 24px; background: #fff; page-break-inside: avoid; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  .header { border-bottom: 3px solid #111; padding-bottom: 20px; margin-bottom: 28px; }
  .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .brand { font-size: 12px; font-weight: 600; letter-spacing: 2px; color: #888; text-transform: uppercase; margin-bottom: 6px; }
  h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 6px; }
  .meta { font-size: 12px; color: #666; }
  .score-pill { background: ${scoreColor}15; border: 2px solid ${scoreColor}; border-radius: 10px; padding: 10px 18px; text-align: center; flex-shrink: 0; }
  .score-num { font-size: 28px; font-weight: 800; font-family: monospace; color: ${scoreColor}; display: block; }
  .score-label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-card { background: #f8f8f8; border-radius: 8px; padding: 12px 14px; }
  .summary-card .val { font-size: 20px; font-weight: 700; font-family: monospace; }
  .summary-card .lbl { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  h2 { font-size: 15px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #888; margin: 28px 0 14px; }
  .risk { border: 1px solid #e8e8e8; border-left: 4px solid #ddd; border-radius: 0 8px 8px 0; padding: 14px 16px; margin-bottom: 10px; page-break-inside: avoid; }
  .risk-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
  .risk-title { font-weight: 700; font-size: 14px; }
  .risk-score { font-family: monospace; font-weight: 800; font-size: 18px; flex-shrink: 0; }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
  .tag-cat { background: #f0f0f0; color: #555; }
  .tag-status { background: #e8f4ff; color: #2266cc; }
  .tag-owner { background: #f0fff4; color: #1a7a3a; }
  .risk-desc { font-size: 13px; color: #333; margin-bottom: 10px; }
  .mitigation-box { background: #fffbf0; border: 1px solid #ffe066; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #555; }
  .mitigation-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #b8930a; margin-bottom: 3px; }
  .scores-row { display: flex; gap: 16px; font-size: 11px; color: #888; margin-bottom: 8px; }
  .scores-row span { font-weight: 600; color: #444; }
  .info-section { background: #f8f8f8; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .info-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 4px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #aaa; display: flex; justify-content: space-between; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page { padding: 16px; } }
</style></head><body>
<div class="page">
  <div class="header">
    <div class="header-top">
      <div>
        <div class="brand">PreShield · Risk Report</div>
        <h1>${project.name}</h1>
        <div class="meta">
          ${project.project_type?.replace(/_/g, " ")} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString()}
          ${project.deadline ? ` &nbsp;·&nbsp; Deadline: ${project.deadline}` : ""}
        </div>
      </div>
      <div class="score-pill">
        <span class="score-num">${parseFloat(project.overall_risk_score || 0).toFixed(1)}</span>
        <span class="score-label">Risk Score</span>
      </div>
    </div>
    ${project.description ? `<p style="margin-top:14px;color:#555;font-size:13px;">${project.description}</p>` : ""}
  </div>

  <div class="matrix-container">
    <div style="font-size:13px; font-weight:700; margin-bottom:12px; text-align:center; text-transform:uppercase; letter-spacing:1px; color:#888;">Risk Matrix</div>
    <svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" style="max-width:100%; height:auto; margin:0 auto; display:block;">
      <text x="${PAD_LEFT + innerW / 2}" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="#111">Impact →</text>
      ${[1, 2, 3, 4, 5].map(v => `<text x="${toX(v)}" y="${PAD_TOP - 12}" text-anchor="middle" font-size="12" fill="#888">${v}</text>`).join('')}
      <text x="18" y="${PAD_TOP + innerH / 2}" text-anchor="middle" font-size="12" fill="#888" transform="rotate(-90, 18, ${PAD_TOP + innerH / 2})">Likelihood</text>
      ${[1, 2, 3, 4, 5].map(v => `<text x="${PAD_LEFT - 14}" y="${toY(v) + 4}" text-anchor="end" font-size="12" fill="#888">${v}</text>`).join('')}
      ${matrixCells.join('')}
      <rect x="${PAD_LEFT}" y="${PAD_TOP}" width="${innerW}" height="${innerH}" fill="none" stroke="#eee" stroke-width="1.5" rx="12" />
      ${matrixDots}
    </svg>
    <div class="matrix-legend" style="display: flex; gap: 20px; justify-content: center; margin-top: 24px; font-size: 12px; color: #666;">
      <div class="legend-item" style="display: flex; align-items: center; gap: 6px;"><div class="legend-color" style="width: 10px; height: 10px; border-radius: 50%; background:#1D9E75"></div>Low</div>
      <div class="legend-item" style="display: flex; align-items: center; gap: 6px;"><div class="legend-color" style="width: 10px; height: 10px; border-radius: 50%; background:#EF9F27"></div>Medium</div>
      <div class="legend-item" style="display: flex; align-items: center; gap: 6px;"><div class="legend-color" style="width: 10px; height: 10px; border-radius: 50%; background:#F57C00"></div>High</div>
      <div class="legend-item" style="display: flex; align-items: center; gap: 6px;"><div class="legend-color" style="width: 10px; height: 10px; border-radius: 50%; background:#E53935"></div>Critical</div>
    </div>
  </div>

  <div class="summary-grid">
    <div class="summary-card"><div class="val">${risks.length}</div><div class="lbl">Total Risks</div></div>
    <div class="summary-card"><div class="val" style="color:#E53935">${risks.filter(r => r.risk_score >= 18).length}</div><div class="lbl">Critical</div></div>
    <div class="summary-card"><div class="val" style="color:#F57C00">${risks.filter(r => r.risk_score >= 12 && r.risk_score < 18).length}</div><div class="lbl">High</div></div>
    <div class="summary-card"><div class="val" style="color:#EF9F27">${risks.filter(r => r.risk_score >= 6 && r.risk_score < 12).length}</div><div class="lbl">Medium</div></div>
    <div class="summary-card"><div class="val" style="color:#1D9E75">${risks.filter(r => r.risk_score < 6).length}</div><div class="lbl">Low</div></div>
  </div>

  <h2>Risk Assessment</h2>
  ${sorted.map((r, i) => `
  <div class="risk" style="border-left-color:${riskColor(r.risk_score)}">
    <div class="risk-row">
      <span class="risk-title">#${i + 1} ${r.title}</span>
      <span class="risk-score" style="color:${riskColor(r.risk_score)}">${parseFloat(r.risk_score).toFixed(1)}</span>
    </div>
    <div class="tags">
      <span class="tag tag-cat">${r.category}</span>
      <span class="tag tag-status">${r.status}</span>
      ${r.owner ? `<span class="tag tag-owner">👤 ${r.owner}</span>` : ""}
    </div>
    <div class="scores-row">
      <div>Likelihood: <span>${parseFloat(r.likelihood).toFixed(1)}/5</span></div>
      <div>Impact: <span>${parseFloat(r.impact).toFixed(1)}/5</span></div>
      <div>Score: <span style="color:${riskColor(r.risk_score)}">${parseFloat(r.risk_score).toFixed(2)}</span></div>
    </div>
    <div class="risk-desc">${r.description}</div>
    <div class="mitigation-box">
      <div class="mitigation-label">Mitigation</div>
      ${r.mitigation || "—"}
    </div>
  </div>`).join("")}

  ${project.stakeholders || project.constraints ? `
  <h2>Project Details</h2>
  ${project.stakeholders ? `<div class="info-section"><div class="info-label">Stakeholders</div>${project.stakeholders}</div>` : ""}
  ${project.constraints ? `<div class="info-section"><div class="info-label">Constraints</div>${project.constraints}</div>` : ""}
  ` : ""}

  <div class="footer">
    <span>PreShield Risk Assessment</span>
    <span>Generated ${new Date().toLocaleDateString()}</span>
  </div>
</div>
</body></html>`;
  };
