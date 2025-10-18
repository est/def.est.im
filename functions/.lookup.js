const CORS = {

}


export async function onRequest(context) {
  const req = context.request

  // only POST
  if (req.method !== 'DEF') {
    return new Response('', {status: 405 })
  }

  let {LLM_API, LLM_MODEL, LLM_TOKEN} = context.env
  let api
  try{
    api = new URL(LLM_API)
  } catch (ex) {
    return new Response.json({'em': 'invalid LLM_API'}, {status: 500 })
  }
  if (!LLM_MODEL){
    return new Response.json({'em': 'invalid LLM_MODEL'})
  }
  const word = (new URL(req.url).searchParams.get('q') || '').trim()
  if (!word){
    return new Response.json({'em': 'empty'})
  }

  const sys_prompt=`
You are a linguistic expert providing dictionary and thesaurus service.
User inputs a WORD, fix misspelling if possible, explain it and respond in strict raw JSON.
Do not wrap the JSON. Format is:
{
  "WORD": "", // the word to be explained
  "IPA": "/xxx/", // pronunciation in International Phonetic Alphabet. Make sure it's wrapped in double quotation marks
  "CONJUGATES": "", // inflections and such, seprate by " | "
  "ETYMOLOGY": "", // example: "From Latin inspirare (in- 'into' + spirare 'breathe'), originally 'to breathe into, infuse spirit'"
  "SINCE": "", // approx. year or era the word first appeared
  "MEANINGS": [ // array of meanings
    {
      "PATTERN": "", // how to use WORD under this meaning, optionally applied with markers like [sb] [sth] etc. Example: if WORD is "inpure", one of the PATTERN is "inspire [sb]". Separate by newline instead of vertical bar
      "POS": "", // grammartically description of the PATTERN. example: "vtr + prep"
      "POS_TIP": "", // tooltip to explain like what is "vtr" and "prep"
      "TAGS": [], // core word, common/rare, old word? Be creative.
      "DEF_EN": "", // definition in simple English
      "DEF_ZH": "", // definition in simple simple Chinese (mainland)
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
  const gatewayRequest = await fetch(`${api.origin}${api.pathname}${api.search}`, {
    method: 'POST',
    headers: {'Authentication': `Bearer ${LLM_TOKEN}`},
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
    rsp = await fetch(gatewayRequest)
    // Return the gateway's response to the client.
  } catch (ex) {
    // If there's an error, return a 500 error to the client.
    console.error(ex)
    return new Response.json({'em': 'failed'}, {status: 502 })
  }

  const em = rsp?.error?.message
  if(em){
    console.error(em)
    return new Response.json({'em': 'gateway error'}, {status: 502})
  }
  const ans = (rsp.choices?.[0]?.message?.content || '').replace(
    /<｜(?:begin|start|end)[\w\s\-▁_]+｜>$/, '').replace(  // fix openrouter cheap models
    /^\s*```json/, '').replace(/```\s*$/, '')   // fix needless code block wraps
  console.debug(ans)
  const data = Object.fromEntries(
      // AI will ocasionally return fuckup cases, like MEANINGS -> MEANings
      Object.entries(JSON.parse(ans)).map(([k, v]) => [k.toUpperCase(), v])
    )
  return new Response.json({result: data})
}
