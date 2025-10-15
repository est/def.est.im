# def.est.im

## About this project

Hosting Webster’s 1913 dictionary online.

## Motivation

英语的 Dictionary 实际出现时间很晚，比《永乐大典》都晚了它妈的至少200多年，因为英语作为一个拼音语言书写统一（正字法）都是很近代的时候才被行政力量推行的。英语在大部分时间里都是被日耳曼蛮子和高卢蛮子看不起的一个小岛口音。

英语词典的发明，是作为乡绅和学者随手一查拿来装逼的，并不是给初学者、外语学习者、特别是中文背景的ESL学生设计的

词典被当成「语法翻译法」的核心工具，其根本原因是印欧语系的语法、词源都能找到共通的联系。而这一套工具本来是贵族用来训练自己的继承子女去学习古希腊语和拉丁语用的。

当讲汉话写中文背景的家长、老师给娃讲英语的时候，就会遇到各种困难或者犯各种啼笑皆非的笑话。

所以想起来通过 ChatGPT 和类似技术做一套「英语」

1. 这个词语用得多不多，是不是很偏门、冷门还是常用词、热词、必背词、高频词
2. 最典型的场景下，具体放在句子的哪个地方
3. 什么时候出现的这个词语，最早什么意思，又因为什么渊源演变成了现在的别的意思
4. 是不是用这个词汇是骂人的、得罪某个群体的，是否需要忌讳
5. 完整列举出所有 conjugation 和 declension 并且阐述和说明，突出的就是一个屈折语的诘屈聱牙。
6. 不拘泥于单个「词」，固定搭配组合也直接当成单词收录用于记忆。

特别是第五点，过去的词典因为印刷和编辑成本很少这样做，现在电子产品完全有能力生成和遍历所有排列组合。

突破「词典」的固有形态，做一个「英语」的说明书。


## 其他词典的问题：

1. Oxford English Dictionary 收费。滚
2. merriam-webster 用高级词汇解释简单词汇。需要thesaurus和dictionary合并到一个界面
3. cambridge 可以，就是排版字体略乱
4. collins 最适合
5. onelook 需要点两下
6. websters1913 最美。适合凭感觉学习。抛开一切语法和构词造句，纯粹体会词义之妙以及如何运用
7. wordreference 最简单明了。比如 `inspire [sb] == awaken [sb]'s creative ideas` 比一个 `[T]` (transitive) 符号更容易理解得多

## 

- [❌] jinja2：SSR，适合SEO
- [X] alpinejs：拿来练手
- 达到MVP路径
   - [X] index.html 改成模板
   - [X] 调通openrouter。特别是CORS问题
   - [X] JSON包裹的一坨
- [ ] [OpenSearch](https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch#OpenSearch_description_file)
- [ ] how to search for new words?

## Credits

- ❌ Google Dictionary API 
- DeepSeek R1 (free) by OpenRouter

## License

BSD
