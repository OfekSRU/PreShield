  const generatePPTXFile = async (project, t, filename) => {
    // Load PptxGenJS library dynamically
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
    script.onload = () => {
      const PptxGenJS = window.PptxGenJS;
      const prs = new PptxGenJS();
      prs.defineLayout({ name: 'LAYOUT1', width: 10, height: 5.625 });
      prs.layout = 'LAYOUT1';

      const risks = project.risks || [];
      const sorted = [...risks].sort((a, b) => b.risk_score - a.risk_score);
      const scoreColor = project.overall_risk_score >= 60 ? "E24B4A" : project.overall_risk_score >= 30 ? "EF9F27" : "1D9E75";
      const riskColor = (s) => s >= 18 ? "E53935" : s >= 12 ? "F57C00" : s >= 6 ? "EF9F27" : "1D9E75";

      // Slide 1: Title
      let slide = prs.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addText("PreShield · Risk Assessment", { x: 0.5, y: 0.5, w: 9, h: 0.4, fontSize: 14, color: "888888", bold: true });
      slide.addText(project.name, { x: 0.5, y: 1.0, w: 9, h: 0.8, fontSize: 44, bold: true, color: "111111" });
      slide.addText(`${project.project_type?.replace(/_/g, " ")} · ${new Date().toLocaleDateString()}${project.deadline ? ` · Deadline: ${project.deadline}` : ""}`, { x: 0.5, y: 1.9, w: 9, h: 0.4, fontSize: 14, color: "666666" });
      if (project.description) slide.addText(project.description, { x: 0.5, y: 2.4, w: 9, h: 1.0, fontSize: 12, color: "555555" });
      
      // Score box
      slide.addShape(prs.ShapeType.rect, { x: 7.5, y: 1.0, w: 2.0, h: 1.2, fill: { color: scoreColor, transparency: 85 }, line: { color: scoreColor, width: 2 } });
      slide.addText(parseFloat(project.overall_risk_score || 0).toFixed(1), { x: 7.5, y: 1.1, w: 2.0, h: 0.5, fontSize: 32, bold: true, color: scoreColor, align: "center" });
      slide.addText("Risk Score", { x: 7.5, y: 1.6, w: 2.0, h: 0.3, fontSize: 10, color: "888888", align: "center" });

      // Slide 2: Summary
      slide = prs.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addText("02", { x: 0.5, y: 0.4, w: 0.8, h: 0.6, fontSize: 24, color: "CCCCCC", bold: true });
      slide.addText("Risk Summary", { x: 1.5, y: 0.5, w: 8, h: 0.5, fontSize: 28, bold: true });
      
      const statBoxes = [
        { label: "Total Risks", value: risks.length, color: "111111" },
        { label: "Critical", value: risks.filter(r => r.risk_score >= 18).length, color: "E53935" },
        { label: "High", value: risks.filter(r => r.risk_score >= 12 && r.risk_score < 18).length, color: "F57C00" },
        { label: "Medium", value: risks.filter(r => r.risk_score >= 6 && r.risk_score < 12).length, color: "EF9F27" },
        { label: "Low", value: risks.filter(r => r.risk_score < 6).length, color: "1D9E75" },
      ];
      
      statBoxes.forEach((box, i) => {
        const x = 0.5 + i * 1.8;
        slide.addShape(prs.ShapeType.rect, { x, y: 1.3, w: 1.6, h: 1.2, fill: { color: "F8F8F8" }, line: { color: box.color, width: 2 } });
        slide.addText(String(box.value), { x, y: 1.45, w: 1.6, h: 0.4, fontSize: 24, bold: true, color: box.color, align: "center" });
        slide.addText(box.label, { x, y: 1.95, w: 1.6, h: 0.3, fontSize: 10, color: "888888", align: "center" });
      });

      // Top 5 risks
      sorted.slice(0, 5).forEach((r, i) => {
        slide.addText(`#${i+1} ${r.title}`, { x: 0.5, y: 2.8 + i * 0.45, w: 7.5, h: 0.35, fontSize: 12, bold: true });
        slide.addText(parseFloat(r.risk_score).toFixed(1), { x: 8.2, y: 2.8 + i * 0.45, w: 1.3, h: 0.35, fontSize: 12, bold: true, color: riskColor(r.risk_score), align: "right" });
      });

      // Slide 3: Risk Matrix
      slide = prs.addSlide();
      slide.background = { color: "FFFFFF" };
      slide.addText("03", { x: 0.5, y: 0.4, w: 0.8, h: 0.6, fontSize: 24, color: "CCCCCC", bold: true });
      slide.addText("Risk Matrix", { x: 1.5, y: 0.5, w: 8, h: 0.5, fontSize: 28, bold: true });
      
      // Draw risk matrix grid matching app styles
      const matrixX = 1.8, matrixY = 1.3, innerW = 6.4, innerH = 3.6;
      const cellW = innerW / 5, cellH = innerH / 5;
      const cellInset = 0.03, cellRx = 0.12;

      const matrixZoneFill = (I, L) => {
        const p = (I * L) / 25;
        if (p < 0.12) return "E8F5E9";
        if (p < 0.28) return "FFE9B5";
        if (p < 0.5) return "FFE0B2";
        return "FFEBEE";
      };
      
      // Draw grid cells
      for (let L = 1; L <= 5; L++) {
        for (let I = 1; I <= 5; I++) {
          const x = matrixX + (I - 1) * cellW;
          const y = matrixY + (5 - L) * cellH;
          slide.addShape(prs.ShapeType.rect, {
            x: x + cellInset, y: y + cellInset, w: cellW - 2 * cellInset, h: cellH - 2 * cellInset,
            fill: { color: matrixZoneFill(I, L) },
            line: { color: "000000", transparency: 93, width: 1 },
            rectRadius: cellRx
          });
        }
      }
      
      // Add axis labels
      slide.addText("Impact →", { x: matrixX, y: matrixY - 0.4, w: innerW, h: 0.4, fontSize: 14, bold: true, color: "111111", align: "center" });
      slide.addText("Likelihood", { x: matrixX - 1.2, y: matrixY + innerH / 2 - 0.5, w: 1, h: 1, fontSize: 12, color: "888888", rotate: 270, align: "center" });
      
      // Axis Ticks
      for (let v = 1; v <= 5; v++) {
        slide.addText(String(v), { x: matrixX + (v - 1) * cellW, y: matrixY - 0.25, w: cellW, h: 0.25, fontSize: 11, color: "888888", align: "center" });
        slide.addText(String(v), { x: matrixX - 0.35, y: matrixY + (5 - v) * cellH, w: 0.35, h: cellH, fontSize: 11, color: "888888", align: "right", valign: "middle" });
      }

      // Plot risks on matrix
      sorted.forEach((r, idx) => {
        const likelihood = Math.min(5, Math.max(1, parseFloat(r.likelihood || 3)));
        const impact = Math.min(5, Math.max(1, parseFloat(r.impact || 3)));
        const dotR = 0.38;
        const cx = matrixX + ((impact - 1) / 4) * (innerW - cellW) + (cellW / 2) - (dotR / 2);
        const cy = matrixY + ((5 - likelihood) / 4) * (innerH - cellH) + (cellH / 2) - (dotR / 2);
        
        slide.addShape(prs.ShapeType.ellipse, {
          x: cx, y: cy, w: dotR, h: dotR,
          fill: { color: riskColor(r.risk_score).replace('#', '') },
          line: { color: "FFFFFF", width: 2 }
        });
        slide.addText(`#${idx + 1}`, { x: cx, y: cy, w: dotR, h: dotR, fontSize: 9, bold: true, color: "FFFFFF", align: "center", valign: "middle" });
      });
      
      slide.addText("Each circle represents one risk, colored by severity", { x: 0.5, y: 5.1, w: 9, h: 0.4, fontSize: 10, color: "888888", align: "center" });

      // Slide 4+: Individual risks (up to 6)
      sorted.slice(0, 6).forEach((r, idx) => {
        slide = prs.addSlide();
        slide.background = { color: "FFFFFF" };
        const riskNum = idx + 4;
        slide.addText(String(riskNum).padStart(2, '0'), { x: 0.5, y: 0.4, w: 0.8, h: 0.6, fontSize: 24, color: riskColor(r.risk_score), bold: true });
        slide.addText(r.title, { x: 1.5, y: 0.5, w: 8, h: 0.5, fontSize: 28, bold: true, color: riskColor(r.risk_score) });
        
        slide.addText(`Score: ${parseFloat(r.risk_score).toFixed(1)}`, { x: 0.5, y: 1.1, w: 2.0, h: 0.3, fontSize: 12, bold: true, color: riskColor(r.risk_score) });
        slide.addText(`Likelihood: ${parseFloat(r.likelihood).toFixed(1)}/5`, { x: 2.7, y: 1.1, w: 2.0, h: 0.3, fontSize: 12, color: "666666" });
        slide.addText(`Impact: ${parseFloat(r.impact).toFixed(1)}/5`, { x: 5.0, y: 1.1, w: 2.0, h: 0.3, fontSize: 12, color: "666666" });
        
        slide.addText("Description", { x: 0.5, y: 1.5, w: 9, h: 0.3, fontSize: 11, bold: true, color: "888888" });
        slide.addText(r.description, { x: 0.5, y: 1.85, w: 9, h: 1.0, fontSize: 11, color: "333333" });
        
        slide.addText("Mitigation", { x: 0.5, y: 2.95, w: 9, h: 0.3, fontSize: 11, bold: true, color: "888888" });
        slide.addShape(prs.ShapeType.rect, { x: 0.5, y: 3.3, w: 9, h: 1.8, fill: { color: "FFFBF0" }, line: { color: "FFE066" } });
        slide.addText(r.mitigation || "—", { x: 0.7, y: 3.45, w: 8.6, h: 1.5, fontSize: 11, color: "555555" });
      });

      prs.save({ fileName: `PreShield_${filename}.pptx` });
    };
    document.head.appendChild(script);
  };
