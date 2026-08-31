const CORS = {

}


const CACHE_SUCCESS = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400';
const CACHE_ERROR = 'no-store, must-revalidate';

export async function onRequest(context) {
  const req = context.request

  // only POST — 非 POST 直接 405 且不缓存
  if (req.method !== 'POST') {
    return new Response('', { status: 405, headers: { 'Cache-Control': CACHE_ERROR, 'X-Content-Type-Options': 'nosniff' } })
  }
  const word = (new URL(req.url).searchParams.get('q') || '').trim()
  if (!word || word.length > 80 || word.split(/\s+/).length > 3){
    return Response.json({'em': 'terrible request'}, { status: 400, headers: { 'Cache-Control': CACHE_ERROR } })
  }
  // read from KV cache — 命中则长缓存：词义稳定，browser 1d / edge 1d
  const e1 = await context.env.kv_def.get(word)
  if(e1){
    return Response.json({'result': JSON.parse(e1)}, { headers: { 'Cache-Control': CACHE_SUCCESS, 'CDN-Cache-Control': CACHE_SUCCESS, 'X-Content-Type-Options': 'nosniff' } })
  }

  let {LLM_API, LLM_MODEL, LLM_TOKEN} = context.env
  let api
  try{
    api = new URL(LLM_API)
  } catch (ex) {
    return Response.json({'em': 'invalid LLM_API'}, { status: 500, headers: { 'Cache-Control': CACHE_ERROR } })
  }
  if (!LLM_MODEL){
    return Response.json({'em': 'invalid LLM_MODEL'}, { headers: { 'Cache-Control': CACHE_ERROR } })
  }
  const sys_prompt=`
You are a linguistic expert providing dictionary and thesaurus service.
User inputs a WORD, fix misspelling, to lower case if possible, restore to base form i explain it and respond in strict raw JSON.
Do not wrap the JSON. Format is:
{
  "WORD": "", // the word to be explained
  "IPA": "/xxx/", // pronunciation in International Phonetic Alphabet. Make sure it's wrapped in double quotation marks
  "CONJUGATES": "", // inflections and such seprated by " | "
  "ETYMOLOGY": "", // example: "From Latin inspirare (in- 'into' + spirare 'breathe'), originally 'to breathe into, infuse spirit'"
  "SINCE": "", // approx. year or era the word first appeared
  "MEANINGS": [ // array of meanings
    {
      "PATTERN": "", // how to use WORD under this meaning, optionally applied with markers like [sb] [sth]. Example: if WORD is "inpure", one of the PATTERN is "inspire [sb]".
      "POS": "", // grammartically description of the PATTERN. example: "vtr + prep"
      "POS_TIP": "", // tooltip to explain like what is "vtr" and "prep"
      "TAGS": [], // core word, common/rare, old word? Be creative.
      "DEF_EN": "", // definition in simple, short English
      "DEF_ZH": "", // definition in simple, short Chinese (mainland)
      "SENT_EN": "", // example sentence in simple English
      "SENT_ZH": "", // example sentence in simple Chinese (mainland)
      "RELATED": [  // synonyms and antonyms under this meaning if any, also give "related" if similar or derivative word/brand/concept is more well known. Only list word itself in "V", no explain
        {"T": "synonyms", "V": ["encourage", "motivate"]},
        {"T": "antonyms", "V": ["defeat", "disinspire"]}
      ]
    }, {}, {}, ...  // other meanings, from most commonly used to least used
  ],
  "REGISTER": "", // where the word is commonly used
}
`
  const gatewayRequest = new Request(`${api.origin}${api.pathname}${api.search}`, {
    method: 'POST',
    headers: {'Authorization': `Bearer ${LLM_TOKEN}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      "model": LLM_MODEL,
      "messages": [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": word}
      ]
    }),
  })

  let rsp
  try {
    rsp = await (await fetch(gatewayRequest)).json()
  } catch (ex) {
    console.error(ex, gatewayRequest.url, gatewayRequest.body)
    return Response.json({'em': 'failed'}, { status: 500, headers: { 'Cache-Control': CACHE_ERROR } })
  }

  const em = rsp?.error?.message
  if(em){
    console.error(em)
    return Response.json({'em': 'gateway error'}, { status: 502, headers: { 'Cache-Control': CACHE_ERROR } })
  }
  const ans = (rsp.choices?.[0]?.message?.content || '').replace(
    /<｜(?:begin|start|end)[\w\s\-▁_]+｜>$/, '').replace(
    /^\s*```json/, '').replace(/```\s*$/, '')
  let ans_data
  try{
    ans_data = JSON.parse(ans)
  } catch (ex) {
    console.debug(ans)
    return Response.json({'em': 'AI error'}, { status: 502, headers: { 'Cache-Control': CACHE_ERROR } })
  }
  const data = Object.fromEntries(
    // AI will ocasionally return fuckup cases, like MEANINGS -> MEANings
    Object.entries(ans_data).map(([k, v]) => [k.toUpperCase(), v])
  )
  data.MEANINGS.forEach((x)=>{x.PATTERN=x.PATTERN.replaceAll(' | ', '\n')})
  await context.env.kv_def.put(data.WORD, JSON.stringify(data))
  // 新词生成成功：同样长缓存，1 天内同一词不再触发 LLM
  return Response.json({result: data}, {headers: {
    'Cache-Control': CACHE_SUCCESS, 'CDN-Cache-Control': CACHE_SUCCESS, 'X-Content-Type-Options': 'nosniff'}})
}
