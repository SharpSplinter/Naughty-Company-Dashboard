import { useState } from "react"

export type ChartSeries = { label: string; values: { label: string; value: number | null }[] }
export type SnapshotHistoryPoint = { day: string; period: number; capturedAt: number; dailyIncome: number | null; weeklyIncome: number | null; dailyProfit: number | null; weeklyProfit: number | null; rating: number | null; companyRank: number | null; companyRankTotal: number | null; stockQuantity: number | null; stockValue: number | null; averageEmployeeEfficiency: number | null }
export type SnapshotHistoryCompany = { companyId: string; name: string; typeName: string; typeId: number; history: SnapshotHistoryPoint[] }
export type SnapshotMetric = "dailyIncome" | "weeklyIncome" | "dailyProfit" | "weeklyProfit" | "stockQuantity" | "stockValue" | "rating" | "companyRank"
export function importedHistorySeries(companies: SnapshotHistoryCompany[], metric: SnapshotMetric): ChartSeries[] {
  const days = Array.from(new Set(companies.flatMap((company) => company.history.map((point) => point.day)))).sort()
  return companies.map((company) => ({ label: company.name, values: days.map((day) => {
    const point = company.history.find((item) => item.day === day)
    const value = point?.[metric]
    return { label: day, value: typeof value === "number" && Number.isFinite(value) ? value : null }
  }) }))
}

export function LineChart({ title, series, money = false }: { title: string; series: ChartSeries[]; money?: boolean }) {
  const [selectedPoint, setSelectedPoint] = useState<{ series: string; label: string; value: number; x: number; y: number } | null>(null)
  const days = Array.from(new Set(series.flatMap((item) => item.values.map((point) => point.label)))).sort()
  const values = series.flatMap((item) => item.values.map((point) => point.value).filter((value): value is number => value !== null && Number.isFinite(value)))
  if (!values.length) return <section className="panel chart-panel"><div className="panel-heading"><h2>{title}</h2></div><div className="empty-state">No recorded values for this company and metric yet.</div></section>
  const width = 800, height = 250, left = 112, right = 22, top = 24, bottom = 40
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1
  const x = (index: number) => left + index * (width - left - right) / Math.max(1, days.length - 1)
  const y = (value: number) => top + (max - value) * (height - top - bottom) / range
  const label = (value: number) => money ? formatMoney(value) : Math.round(value).toLocaleString()
  const selectedX = selectedPoint ? Math.max(left + 60, Math.min(width - right - 60, selectedPoint.x)) : 0
  const selectedY = selectedPoint ? Math.max(top + 12, selectedPoint.y - 16) : 0
  return <section className="panel chart-panel"><div className="panel-heading"><div><h2>{title}</h2><p>Unified daily timeline · historical and live snapshots · UTC</p></div><div className="chart-legend">{series.map((item, index) => <span key={item.label}><i className={`chart-key chart-key-${index % 3}`} />{item.label}</span>)}</div></div><div className="chart-scroll"><svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title}>{Array.from({length:4},(_,i)=>{const yy=top+i*(height-top-bottom)/3;return <g key={i}><line x1={left} x2={width-right} y1={yy} y2={yy} className="chart-grid"/><text x={left-8} y={yy+4} textAnchor="end" className="chart-label">{label(max-i*range/3)}</text></g>})}{series.map((item,index)=>{const byDay = new Map(item.values.map((point) => [point.label, point.value]));const points = days.flatMap((day,i)=>{const value=byDay.get(day);return value===null||value===undefined?[]:[`${x(i)},${y(value)}`]}).join(" ");return <g key={item.label}><polyline points={points} className={`chart-line chart-line-${index%3}`}/>{days.map((day,i)=>{const value=byDay.get(day);if(value===null||value===undefined)return null;const px=x(i),py=y(value);return <circle key={`${day}-${i}`} cx={px} cy={py} r={selectedPoint?.series===item.label&&selectedPoint.label===day?5:3.5} className={`chart-point chart-line-${index%3}`} role="button" tabIndex={0} aria-label={`${item.label}, ${day}: ${label(value)}`} onClick={()=>setSelectedPoint({series:item.label,label:day,value,x:px,y:py})} onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelectedPoint({series:item.label,label:day,value,x:px,y:py})}}}><title>{`${item.label} · ${day}: ${label(value)}`}</title></circle>})}</g>})}{selectedPoint && <g className="chart-selected-value" aria-live="polite"><rect x={selectedX-60} y={selectedY-28} width="120" height="44" rx="6"/><text x={selectedX} y={selectedY-11} textAnchor="middle">{selectedPoint.label}</text><text x={selectedX} y={selectedY+5} textAnchor="middle">{label(selectedPoint.value)}</text></g>}<text x={left} y={height-10} className="chart-label">{days[0] ?? ""}</text><text x={width-right} y={height-10} textAnchor="end" className="chart-label">{days.at(-1) ?? ""}</text></svg></div><p className="chart-interaction-hint">Select any point to view its exact date and value.</p></section>
}
export function stockInventoryValue(stock: unknown): number | null {
  if (!stock || typeof stock !== "object") return null
  const values: number[] = []
  const visit = (value: unknown, depth: number) => { if (!value || typeof value !== "object" || depth > 6) return; if (Array.isArray(value)) { value.forEach((item) => visit(item, depth+1)); return } const row=value as Record<string,unknown>; const qty=[row.in_stock,row.quantity,row.amount].find((n)=>typeof n==="number"&&Number.isFinite(n)) as number|undefined; const cost=[row.cost,row.unit_cost,row.cost_per_unit].find((n)=>typeof n==="number"&&Number.isFinite(n)) as number|undefined; if(qty!==undefined&&cost!==undefined)values.push(Math.max(0,qty)*Math.max(0,cost)); for(const [key,child] of Object.entries(row))if(!["in_stock","quantity","amount","cost","unit_cost","cost_per_unit"].includes(key))visit(child,depth+1) }
  visit(stock,0); return values.length ? values.reduce((sum,value)=>sum+value,0) : null
}

function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : "$" + value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}
