const CORS = {

}


export async function onRequest(context) {
  const req = context.request

  // only POST
  if (req.method !== 'POST') {
    return new Response('', {status: 405 })
  }
  const word = (new URL(req.url).searchParams.get('q') || '').trim()
  if (!word || word.length > 250){
    return Response.json({'em': 'terrible request'})
  }
  // read from KV cache
  const exist = await context.env.kv_def.get(word)
  if(exist){
    return Response.json({'result': JSON.parse(exist)})
  }
  let {LLM_API, LLM_MODEL, LLM_TOKEN} = context.env
  let api
  try{
    api = new URL(LLM_API)
  } catch (ex) {
    return Response.json({'em': 'invalid LLM_API'}, {status: 500 })
  }
  if (!LLM_MODEL){
    return Response.json({'em': 'invalid LLM_MODEL'})
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
    // Fetch the response from the gateway.
    rsp = await (await fetch(gatewayRequest)).json()
    // Return the gateway's response to the client.
  } catch (ex) {
    // If there's an error, return a 500 error to the client.
    console.error(ex, gatewayRequest.url, gatewayRequest.body)
    return Response.json({'em': 'failed'})
  }

  const em = rsp?.error?.message
  if(em){
    console.error(em)
    return Response.json({'em': 'gateway error'})
  }
  const ans = (rsp.choices?.[0]?.message?.content || '').replaceAll(
    /<｜(?:begin|start|end)[\w\s\-▁_]+｜>$/, '').replaceAll(  // fix openrouter cheap models
    /^\s*```json/, '').replaceAll(/```\s*$/, '')   // fix needless code block wraps
  let ans_data
  try{
    ans_data = JSON.parse(ans)
  } catch (ex) {
    console.debug(ans)
    return Response.json({'em': 'AI error'})
  }
  const data = Object.fromEntries(
    // AI will ocasionally return fuckup cases, like MEANINGS -> MEANings
    Object.entries(ans_data).map(([k, v]) => [k.toUpperCase(), v])
  )
  data.MEANINGS.forEach((x)=>{x.PATTERN=x.PATTERN.replaceAll(' | ', '\n')})
  // @ToDo write to cloudflare KV cache for {data.WORD: data}
  await context.env.kv_def.put(data.WORD, JSON.stringify(data))
  return Response.json({result: data}, {headers: {
    'Cache-Control': 'public, max-age=3600'}})
}
