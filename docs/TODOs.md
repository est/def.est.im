
## 20260819  开通线上 AI 查词的idea：

1. 多个词积累到一起查，节约AI
2. 避免无意义的单词、短句入库。prompt 里要求AI给出是否值得作为词典记录的建议
3. AI返回不规范的验证拦截重试机制
4. 如果词语已收录则扩充原词，而不是新建一个 lemma 。但是也有例外，比如 cooked 这个网络用语已经有引申含义了（死定了），sb. is cooking 这种也是固定搭配，比较难办
5. 用 [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/index.md) 限流防止刷爆
6. user-agent 如果是 AI 的，并且检查 `sec-fetch-*` 不是浏览器的，就不要费力气
7. 看看还有没有能加强缓存的，省钱



## 20260819 数据公开的考虑


想做成可以网友维护更新的，首选肯定是 JSON 放到 github。但是这个 sqlite 也有 70MB 了，4w词汇就是4w个文件，有点太大了？

