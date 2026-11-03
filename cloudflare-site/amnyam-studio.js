(() => {
"use strict";
const $=id=>document.getElementById(id), KEY="amnyam.studio.v1";
const W=[["pulse","Состояние рынка"],["radar","Лучшие возможности"],["movement","Движение рынка"],["watchlist","Мой мониторинг"],["saved","Мои сценарии"]];
const DEFAULT={order:W.map(x=>x[0]),hidden:[],compactMarket:false};
let settings,profileKey="guest",market=null;
const valid=new Set(W.map(x=>x[0]));
const clean=v=>{const x=v&&typeof v==="object"?v:{};const order=Array.isArray(x.order)?x.order.filter((id,i,a)=>valid.has(id)&&a.indexOf(id)===i):[];W.forEach(w=>{if(!order.includes(w[0]))order.push(w[0])});return{order,hidden:Array.isArray(x.hidden)?[...new Set(x.hidden.filter(id=>valid.has(id)))]:[],compactMarket:x.compactMarket===true}};
const storageKey=()=>KEY+"."+profileKey;
const read=()=>{try{return clean(JSON.parse(localStorage.getItem(storageKey())||"null"))}catch(_){return clean(DEFAULT)}};
const copy=()=>({order:settings.order.slice(),hidden:settings.hidden.slice(),compactMarket:settings.compactMarket});
const fmt=v=>Number.isFinite(Number(v))?Number(v).toLocaleString("ru-RU",{maximumFractionDigits:1}):"—";
const coin=v=>Number.isFinite(Number(v))?fmt(v)+" ◉":"—";
const date=v=>{const d=new Date(v||"");return Number.isFinite(d.getTime())?d:null};
const ago=v=>{const d=date(v);if(!d)return"время не указано";const m=Math.max(0,Math.floor((Date.now()-d.getTime())/60000));return m<60?m+" мин назад":m<1440?Math.floor(m/60)+" ч назад":Math.floor(m/1440)+" дн назад"};
const el=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=String(txt);return n};
const btn=(txt,fn,cls="btn secondary")=>{const b=el("button",cls,txt);b.type="button";b.addEventListener("click",fn);return b};
const dispatch=(name,detail)=>window.dispatchEvent(new CustomEvent(name,{detail}));
function setDensity(){document.body.classList.toggle("market-compact",settings.compactMarket);const c=$("studioCompactMarket"),b=$("studioMarketDensityButton");if(c)c.checked=settings.compactMarket;if(b){b.setAttribute("aria-pressed",String(settings.compactMarket));b.textContent=settings.compactMarket?"Стандартный вид":"Компактный вид"}}
function save(notify=true){try{localStorage.setItem(storageKey(),JSON.stringify(copy()))}catch(_){}setDensity();render();controls();if(notify)dispatch("amnyam:studio-change",copy())}
function profileKeySet(v){const next=/^(?:guest|[A-Za-z0-9_-]{1,64})$/.test(String(v||""))?String(v):"guest";if(next===profileKey)return;profileKey=next;settings=read();save(false)}
function nav(view){document.querySelector('#mainNav [data-view="'+view+'"]')?.click()}
function openLot(id){dispatch("amnyam:studio-open-lot",{lotId:String(id)})}
function quick(id){if(["deals","cheap","favorites"].includes(id))nav(id);else if(id==="usernames")document.querySelector('#marketTypeNav [data-market-type="usernames"]')?.click();else dispatch("amnyam:studio-filter",{key:id})}
function lots(){return Array.isArray(market?.lots)?market.lots.filter(x=>x&&x.active!==false):[]}
function bestDeals(){
  const confidence = value => value === "high" ? 3 : value === "medium" ? 2 : 1;
  return (Array.isArray(market?.deals) ? market.deals : [])
    .filter(x => x && !x.suspicious && Number.isFinite(Number(x.price)) && Number.isFinite(Number(x.discount_pct)))
    .sort((a,b) =>
      confidence(b.confidence) - confidence(a.confidence) ||
      (a.basis === b.basis ? 0 : a.basis === "sales" ? -1 : 1) ||
      (Number(b.sample_size)||0) - (Number(a.sample_size)||0) ||
      Number(b.score||b.discount_pct||0) - Number(a.score||a.discount_pct||0) ||
      Number(a.price)-Number(b.price)
    ).slice(0,3);
}
function card(id,title,sub){const c=el("article","studio-widget studio-widget-"+id);c.dataset.studioWidget=id;const h=el("header","studio-widget-head");const copy=el("div","");copy.append(el("span","studio-widget-code","AMNYAM / "+id.toUpperCase()),el("h3","",title),el("p","",sub));h.append(copy);c.append(h);const body=el("div","studio-widget-body");c.append(body);return{c,body}}
function pulse(){const{c,body}=card("pulse","Состояние рынка","Текущий снимок и Live-сигнал");const ls=lots(),p=ls.map(x=>Number(x.price)).filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b),m=p.length?(p.length%2?p[(p.length-1)/2]:(p[p.length/2-1]+p[p.length/2])/2):null,live=market?.data?.live||{},stats=[["АКТИВНЫЕ ЛОТЫ",fmt(ls.length)],["МЕДИАНА",coin(m)],["СИГНАЛЫ НИЖЕ РЫНКА",fmt(bestDeals().length)],["ИЗБРАННОЕ",fmt((market?.favorites||[]).length)]];const grid=el("div","studio-metric-grid");stats.forEach(([k,v])=>{const x=el("div","studio-metric");x.append(el("small","",k),el("b","",v));grid.append(x)});const status=el("div","studio-health-line");status.append(el("i",live.enabled&&live.fresh?"is-fresh":"is-stale"),el("span","",live.enabled&&live.fresh?"Live поступает · "+ago(live.last_poll_at):"Live не подтверждён — проверь свежесть"));if(market?.data?.generated_at)status.append(el("small","","Снимок "+ago(market.data.generated_at)));body.append(grid,status);return c}
function radar(){const{c,body}=card("radar","Лучшие возможности","Сильные скидки с достаточным количеством аналогов");const rows=bestDeals();if(!rows.length)body.append(el("p","studio-empty","Пока нет подходящих сигналов с достаточной выборкой."));rows.forEach((x,i)=>{const row=el("div","studio-opportunity"),left=el("div","studio-opportunity-main");left.append(el("b","",x.title||("Лот #"+x.lot_id)),el("small","","#"+x.lot_id+" · "+fmt(x.sample_size)+" аналогов · "+(x.basis==="sales"?"подтверждённые продажи":"цены объявлений")+" · ориентир "+coin(x.reference_price)+" · надёжность "+(x.confidence==="high"?"высокая":x.confidence==="medium"?"средняя":"низкая")));row.append(el("span","studio-rank","0"+(i+1)),left,el("strong","studio-opportunity-price",coin(x.price)+" · −"+fmt(x.discount_pct)+"%"),btn("↗",()=>openLot(x.lot_id),"studio-open-mini"));body.append(row)});body.append(btn("Все возможности →",()=>nav("deals")));return c}
function movement(){const{c,body}=card("movement","Движение рынка","Новые объявления и снижения цены");const ls=lots(),drops=ls.filter(x=>Number.isFinite(Number(x._delta))&&Number(x._delta)<0).sort((a,b)=>a._delta-b._delta).slice(0,3),newest=ls.filter(x=>date(x.first_seen)).sort((a,b)=>date(b.first_seen)-date(a.first_seen)).slice(0,3);[[ "ЦЕНА СНИЖАЕТСЯ",drops,"drop"],["НОВЫЕ В РЫНКЕ",newest,"new"]].forEach(([title,rows,type])=>{const group=el("div","studio-movement-group");group.append(el("b","studio-group-title",title));if(!rows.length)group.append(el("p","studio-empty","Нет подтверждённых изменений в доступной истории."));rows.forEach(x=>{const left=el("div",""),row=el("div","studio-movement-row");left.append(el("b","",x.title||("Лот #"+x.lot_id)),el("small","","#"+x.lot_id+" · "+(type==="drop"?ago(x.last_seen||x.first_seen):ago(x.first_seen))));row.append(left,el("strong",type==="drop"?"studio-down":"studio-neutral",type==="drop"?fmt(x._delta)+"%":coin(x.price)),btn("Открыть",()=>openLot(x.lot_id),"studio-open-mini"));group.append(row)});body.append(group)});return c}
function watchlist(){const{c,body}=card("watchlist","Мой мониторинг","Избранное и личные ценовые цели");const fav=(market?.favorites||[]).map(String),targets=market?.targets||{},all=lots();const rows=fav.map(id=>all.find(x=>String(x.lot_id)===id)).filter(Boolean).slice(0,5);if(!rows.length)body.append(el("p","studio-empty",fav.length?"Лоты сохранены, но отсутствуют в текущем снимке.":"Добавляй интересные лоты в избранное."));rows.forEach(x=>{const target=Number(targets[String(x.lot_id)]),reached=Number.isFinite(target)&&Number(x.price)<=target,left=el("div",""),row=el("div","studio-watch-row");left.append(el("b","",x.title||("Лот #"+x.lot_id)),el("small","","Цена "+coin(x.price)+(Number.isFinite(target)?" · цель "+coin(target):" · цель не задана")));row.append(left,el("span",reached?"studio-target-reached":"studio-watch-state",reached?"ЦЕЛЬ":"В ОЖИДАНИИ"),btn("↗",()=>openLot(x.lot_id),"studio-open-mini"));body.append(row)});body.append(btn("Открыть избранное →",()=>nav("favorites")));return c}
function saved(){const{c,body}=card("saved","Мои сценарии","Сохранённые фильтры и быстрые переходы");const presets=Array.isArray(market?.savedFilters)?market.savedFilters:[];if(!presets.length)body.append(el("p","studio-empty","Сохрани фильтр в Маркете — он появится здесь."));else{const group=el("div","studio-preset-list");presets.slice(0,8).forEach(x=>group.append(btn(x.name,()=>dispatch("amnyam:studio-apply-preset",{name:x.name}),"studio-preset-button")));body.append(group)}const links=el("div","studio-saved-actions");links.append(btn("Снайпер →",()=>nav("sniper")),btn("Аналитика →",()=>nav("analytics")),btn("Портфель →",()=>nav("portfolio")));body.append(links);return c}
const renderers={pulse,radar,movement,watchlist,saved};
function render(){const root=$("studioWidgets");if(!root)return;root.replaceChildren();const visible=settings.order.filter(id=>!settings.hidden.includes(id));visible.forEach(id=>{if(renderers[id])root.append(renderers[id]())});if(!visible.length)root.append(el("p","studio-empty","Все виджеты скрыты. Верни нужные в настройках станции."));const live=market?.data?.live||{};$("studioMarketStatus").textContent=live.enabled&&live.fresh?"LIVE · "+ago(live.last_poll_at).toUpperCase():"СНИМОК · ПРОВЕРЬ СВЕЖЕСТЬ";$("studioUpdatedAt").textContent=market?.data?.generated_at?"Снимок "+ago(market.data.generated_at):"Ожидаем обновление";setDensity()}
function controls(){const root=$("studioWidgetControls");if(!root)return;root.replaceChildren();settings.order.forEach((id,i)=>{const row=el("div","studio-control-row"),label=el("label","studio-control-label"),check=el("input",""),meta=W.find(x=>x[0]===id);check.type="checkbox";check.checked=!settings.hidden.includes(id);check.addEventListener("change",()=>{settings.hidden=check.checked?settings.hidden.filter(x=>x!==id):[...settings.hidden.filter(x=>x!==id),id];save()});label.append(check,el("span","",meta?.[1]||id));const up=btn("↑",()=>move(id,-1),"studio-move"),down=btn("↓",()=>move(id,1),"studio-move");up.disabled=i===0;down.disabled=i===settings.order.length-1;row.append(label,up,down);root.append(row)})}
function move(id,dir){const i=settings.order.indexOf(id),j=i+dir;if(j<0||j>=settings.order.length)return;const a=settings.order.slice();[a[i],a[j]]=[a[j],a[i]];settings.order=a;save()}
function setProfile(value){settings=clean(value);save(false)}
function parseNaturalQuery(raw){
  let rest=String(raw||"").trim(), lower=rest.toLocaleLowerCase("ru");
  if(/скидк|ниже рынка|выгодн|лучшие возможности/.test(lower))return{view:"deals",message:"Открываю возможности с текущими правилами проверки аналогов."};
  const parts=[];
  const money=rawValue=>{
    const compact=String(rawValue||"").toLowerCase().replace(/\s/g,"").replace(",",".");
    const match=compact.match(/^(\d+(?:\.\d+)?)([кkmм]?)$/i);
    if(!match)return null;
    let value=Number(match[1]);
    if(/[кk]/.test(match[2]))value*=1000;
    if(/[мm]/.test(match[2]))value*=1000000;
    return Number.isSafeInteger(Math.round(value))?Math.round(value):null;
  };
  const under=rest.match(/(?:дешевле|не дороже|меньше|до)\s*(\d[\d\s]*(?:[,.]\d+)?\s*[кkmм]?)/i);
  if(under){const value=money(under[1]);if(value!=null){parts.push("price<"+(value+0.0000001));rest=rest.replace(under[0]," ");}}
  const over=rest.match(/(?:дороже|не дешевле|больше|выше|от)\s*(\d[\d\s]*(?:[,.]\d+)?\s*[кkmм]?)/i);
  if(over){const value=money(over[1]);if(value!=null){parts.push("price>"+(value-0.0000001));rest=rest.replace(over[0]," ");}}
  const removeText=(value)=>{
    const index=rest.toLocaleLowerCase("ru").indexOf(String(value).toLocaleLowerCase("ru"));
    if(index>=0)rest=rest.slice(0,index)+" "+rest.slice(index+String(value).length);
  };
  const findFacet=(options)=>{
    const words=lower.split(" ").filter(Boolean);
    for(const option of options){
      const phrases=[option.textContent,option.value].map(value=>String(value||"").toLocaleLowerCase("ru")).filter(Boolean);
      for(const phrase of phrases)if(lower.includes(phrase))return{option,matched:phrase};
      for(const phrase of phrases){
        const stem=phrase.split(" ")[0].slice(0,4);
        if(stem.length>=3){const matched=words.find(word=>word.startsWith(stem));if(matched)return{option,matched};}
      }
    }
    return null;
  };
  const rarityOptions=Array.from(document.querySelectorAll("#rarity option")).filter(option=>option.value);
  const rarityMatch=findFacet(rarityOptions);
  if(rarityMatch){parts.push('rarity:"'+rarityMatch.option.value.replace(/"/g,"")+'"');removeText(rarityMatch.matched);}
  const statusOptions=Array.from(document.querySelectorAll("#status option")).filter(option=>option.value);
  const statusMatch=findFacet(statusOptions);
  if(statusMatch){parts.push('status:"'+statusMatch.option.value.replace(/"/g,"")+'"');removeText(statusMatch.matched);}
  const ignored=new Set(["найди","покажи","подарки","подарок","лоты","лот","среди","дешевле","меньше","до","дороже","больше","выше","от","не","рынку","цена","ценой","стоимостью","и","с","по","в","на","для","мне","мои","новые"]);
  const terms=rest.toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}_-]+/gu," ").split(/\s+/).filter(word=>word&&!ignored.has(word));
  parts.push(...terms);
  const dsl=parts.join(" ").trim();
  return dsl?{query:dsl,message:"Применены фильтры: "+dsl}:{error:"Не понял запрос. Пример: «редкие подарки дешевле 3000» или «подарки дороже 5000»."};
}
function submitNaturalQuery(){
  const field=$("studioNaturalQuery"),status=$("studioNaturalStatus");
  const parsed=parseNaturalQuery(field.value);
  if(parsed.error){status.textContent=parsed.error;status.dataset.tone="error";return;}
  dispatch("amnyam:studio-query",parsed);
  status.textContent=parsed.message;
  status.dataset.tone="success";
}
function init(){settings=read();setDensity();$("studioCustomize").addEventListener("click",()=>{const panel=$("studioCustomizePanel"),open=panel.classList.toggle("hide")===false;$("studioCustomize").setAttribute("aria-expanded",String(open))});$("studioResetLayout").addEventListener("click",()=>{settings=clean(DEFAULT);save()});$("studioCompactMarket").addEventListener("change",e=>{settings.compactMarket=e.target.checked;save()});$("studioMarketDensityButton").addEventListener("click",()=>{settings.compactMarket=!settings.compactMarket;save()});$("studioQuickFilters").addEventListener("click",e=>{const b=e.target.closest("[data-studio-filter]");if(b)quick(b.dataset.studioFilter)});$("studioNaturalSearch").addEventListener("submit",e=>{e.preventDefault();submitNaturalQuery()});window.addEventListener("amnyam:market",e=>{market=e.detail||null;if(market.profileKey)profileKeySet(market.profileKey);render()});window.addEventListener("amnyam:studio-profile",e=>{if(e.detail?.profileKey)profileKeySet(e.detail.profileKey);if(e.detail?.settings)setProfile(e.detail.settings)});if(window.AMNYAM_MARKET){market=window.AMNYAM_MARKET;if(market.profileKey)profileKeySet(market.profileKey)}controls();render()}
window.AMNYAM_STUDIO_SETTINGS={get:copy,set:setProfile};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();