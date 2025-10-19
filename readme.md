# def.est.im

## About

一开始觉得搞个 Google Dictionary 离线版；

后来看到 Webster’s 1913 好厉害，做个在线版。

其实早有人做了。比如 websters1913.com。GNU Dic 也是基于它的；

ChatGPT 出来之后，干脆外包给AI做吧。

[写了个blog](https://blog.est.im/2025/stdout-12) 

## ToDo

- [ ] 错误拼写跳转；大小写如何关联；缩写，符号，美英差异等如何归一化？
- [ ] 反查哪些属于 Common, General
- [ ] 把 register 包含 Common, General 的都cache一遍
- [ ] 把中小学词汇都预热到KV cache里。省钱
- [ ] 限流，防止API爆掉
- [ ] [OpenSearch](https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch#OpenSearch_description_file)，[tab-to-search](https://www.chromium.org/tab-to-search/)
- [ ] jinja2：SSR，适合SEO。有闲心再说
- [X] alpinejs：拿来练手
- [X] how to search for new words?
- 达到MVP：
   - [X] index.html 改成模板
   - [X] 调通openrouter。特别是CORS问题
   - [X] JSON包裹的一坨

## Credits

- ❌ Google Dictionary API 
- DeepSeek R1 (free) by OpenRouter
- Gemini Flash

## License

BSD
