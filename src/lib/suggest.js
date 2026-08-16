// 拼写归一候选：未命中词生成候选拼写（常见错误表 + 美英变体 + 相邻换位）
// 供 lookup.js 在 missing 分支调用——命中则 302 跳转，错误拼写不再触发 on-demand 烧 LLM
'use strict';

// 常见高频拼写错误 → 正确拼写（小写；美式优先）
const SPELL_FIX = {
  teh: ['the'], hte: ['the'], taht: ['that'], htat: ['that'], wich: ['which'],
  recieve: ['receive'], receieve: ['receive'], seperate: ['separate'], sepaprate: ['separate'],
  occured: ['occurred'], occuring: ['occurring'], untill: ['until'], untilll: ['until'],
  definately: ['definitely'], definetly: ['definitely'], definitly: ['definitely'],
  goverment: ['government'], enviroment: ['environment'], envoronment: ['environment'],
  adress: ['address'], adresss: ['address'], accomodate: ['accommodate'], accomodation: ['accommodation'],
  wierd: ['weird'], beutiful: ['beautiful'], freind: ['friend'], freinds: ['friends'],
  wensday: ['wednesday'], thier: ['their'], ther: ['their', 'there'], alot: ['a lot'],
  arguement: ['argument'], acheive: ['achieve'], beleive: ['believe'], neccessary: ['necessary'],
  occassion: ['occasion'], oppurtunity: ['opportunity'], persistant: ['persistent'],
  recomend: ['recommend'], refered: ['referred'], relevent: ['relevant'], succesful: ['successful'],
  tommorow: ['tomorrow'], truely: ['truly'], twelth: ['twelfth'], unfortunatly: ['unfortunately'],
  writting: ['writing'], begining: ['beginning'], calender: ['calendar'], definate: ['definite'],
  dissappear: ['disappear'], embarass: ['embarrass'], existance: ['existence'], grammer: ['grammar'],
  independant: ['independent'], intresting: ['interesting'], knowlege: ['knowledge'],
  libary: ['library'], lisence: ['license'], maintainance: ['maintenance'], millenium: ['millennium'],
  neccessarily: ['necessarily'], noticable: ['noticeable'], occassionally: ['occasionally'],
  particulary: ['particularly'], peice: ['piece'], posession: ['possession'], priviledge: ['privilege'],
  pronunication: ['pronunciation'], publically: ['publicly'], quater: ['quarter'],
  realy: ['really'], restaraunt: ['restaurant'], seperateing: ['separating'],
  skilful: ['skillful'], sucessful: ['successful'], supercede: ['supersede'],
  tehcnology: ['technology'], temperatur: ['temperature'], tomorow: ['tomorrow'],
  twon: ['town'], vegtable: ['vegetable'], wichh: ['which'], yeild: ['yield'],
  exersize: ['exercise'], exercize: ['exercise'], becuase: ['because'], becouse: ['because'],
  buisness: ['business'], buiness: ['business'], carrer: ['career'], commitee: ['committee'],
  concious: ['conscious'], deteriate: ['deteriorate'], eqivalent: ['equivalent'],
  expierence: ['experience'], familar: ['familiar'], foriegn: ['foreign'], gaurd: ['guard'],
  happend: ['happened'], heared: ['heard'], imediate: ['immediate'], invincible: ['invincible'],
  jealosy: ['jealousy'], knifes: ['knives'], lenght: ['length'], mentall: ['mental'],
  ocasion: ['occasion'], pasttime: ['pastime'], peice: ['piece'], personel: ['personnel'],
  presistent: ['persistent'], pretier: ['prettier'], realse: ['release'],
  religous: ['religious'], responsability: ['responsibility'], seige: ['siege'],
  similiar: ['similar'], sincerly: ['sincerely'], somtimes: ['sometimes'],
  specificaly: ['specifically'], strat: ['start'], succsess: ['success'],
  surprize: ['surprise'], temperatue: ['temperature'], tenture: ['tenure'],
  theif: ['thief'], throughly: ['thoroughly'], tolerent: ['tolerant'],
  transfered: ['transferred'], unecessary: ['unnecessary'], useage: ['usage'],
  vaccum: ['vacuum'], viewd: ['viewed'], wierdly: ['weirdly'],
};

// 美英拼写变体规则（英式 → 美式；反向也试，靠 surfaces 校验兜底）
const US_RULES = [
  [/isation$/, 'ization'], [/isational$/, 'izational'], [/ised$/, 'ized'], [/ising$/, 'izing'], [/ise$/, 'ize'],
  [/yse$/, 'yze'], [/our$/, 'or'], [/ourly$/, 'orly'],
  [/re$/, 'er'], [/logue$/, 'log'], [/ogue$/, 'og'],
  [/lled$/, 'led'], [/lling$/, 'ling'], [/ller$/, 'ler'], [/llest$/, 'lest'], [/llful$/, 'lful'],
  [/ae$/, 'e'], [/oe$/, 'e'], [/aei/, 'ei'], [/oei/, 'ei'],
];

function spellingVariants(word) {
  const out = new Set();
  for (const [re, rep] of US_RULES) {
    const m = re.exec(word);
    if (m && m[0] !== rep) out.add(word.slice(0, m.index) + word.slice(m.index).replace(re, rep));
  }
  return [...out];
}

// 相邻字母换位（teh→the）
function transpositions(word) {
  const out = new Set();
  for (let i = 0; i < word.length - 1; i++) {
    if (word[i] === word[i + 1]) continue;
    out.add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  return [...out];
}

// 主入口：生成候选（去重、去自身、限 12 个；优先级 常见表 > 美英规则 > 换位）
function suggestCandidates(word) {
  const low = word.toLowerCase();
  const out = [];
  const seen = new Set([low]);
  const push = (ws) => {
    for (const w of ws) {
      const k = w.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  };
  push(SPELL_FIX[low] ?? []);
  push(spellingVariants(low));
  push(transpositions(low));
  return out.slice(0, 12);
}

export { suggestCandidates };
