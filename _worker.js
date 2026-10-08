// 全局内存缓存（L1 缓存）
const tgUserModels = new Map();

// v6.8.1 有界内存缓存：isolate 常驻时 Map 只增不减会缓慢泄漏。
// 超过上限时淘汰最早插入的条目（Map 保持插入序）；淘汰只是丢 L1，
// 下次自动回退读 R2，行为安全。
const MEM_CACHE_MAX = 2000;
function mapSetBounded(map, key, value, max) {
  map.set(key, value);
  const limit = max > 0 ? max : MEM_CACHE_MAX;
  // 在 Map 迭代中删除是安全的；跳过刚写入的 key，避免误删本次写入
  for (const k of map.keys()) {
    if (map.size <= limit) break;
    if (k === key) continue;
    map.delete(k);
  }
}

// 优化：不再校验 env 的引用，因为 Worker 生命周期内环境变量是恒定的
let cachedConfig = null; 

// 复用 HTTP 响应头结构
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

const HTML_HEADERS = { 'Content-Type': 'text/html;charset=UTF-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

// 应用版本号（/help 显示；发版时同步 package.json）
const APP_VERSION = '6.8.3';

// ================= PWA =================
// 图标以 base64 内嵌，运行时解码；不引入任何静态资源文件，
// 保证「单文件 Worker / 无额外构建产物」的部署方式不被破坏。
const ICON_B64 = {
  '/icon-192.png': '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',
  '/icon-512.png': 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAhMUlEQVR42u3db4xl5X0f8GcG899lx7QsTlyJAedNHNdM0xetHS9csN03TsRG9otIpmFQIseOmrA4TqSqNjvEqSITR2xS2HUjsTsLBtwmKYscJ3YixXdcKRUmkmdtnFdOGaoSBUhhabx/2AWm53fnXDy77OzOn3vPv+fzkX5rC5bduc+95/l9z3Oee85konF+6jeP3VjWHUXtLusbq+rbRS0rpVRD6ttnzFHDeeuO4XxmZm+eSUNQW5O/pjww4iA5UB40L8XBVPzrfll7iporq7eqZowg0CAzZ8xRw3lrz3A+K4PCS+Vcd6Cc+2IOvMbwCQBdb/a3rDqTf6n4x0vlgREHyWx50EwZLaDDpsq5brac+2IOXFoVDHaXc6VQIAC0uuHfVqbcp8tmf2jVmbxGD/DmYDBXzpURCp4u59DbBAIBoOlNP5ay7o1rYWXDny9T7rTRAdiw6XIOnS8DwbfLOdZ+AgGgEU3/ljKhxpJ+v6hdyfV5gHGYKefYfnnJIObeWwyLAFCZ95/e9A+VCdWSPkB1psq599AwDLxfGBAAxtT0ry/q3veXTX+i+OAVNVVUUkopVWvFXDwIAzFHl3P19TqXALCVpr+tqNvev3JNf7FcenKmD9DslYGYqxdj7i7n8G2GRQBYX+O/+9g1Rd2bltNSUfNFzaT4Zr5SSqk21Uw5hy/FnB5zuw4nAKzV+K8v6kBa2cHvbB+gW6sCEQQOxFxvSASAYeO/sahvpJVl/lkfCYDOijl+Meb8mPsFAI2/n1ZuQAFAHmLO7+ceBLILAOVSv8YPwOogkN2lgWwCQLm5L67xL2r8AJwRBBbLPQLZbBbsfAAo3sxtRe1OrvEDcG6zZRDYHb1DAGh387+lbPxzya5+AM5vquwZi2UPEQBa1vivKa/zx616p32eAdig6B2Hyv0Bnbws0LkAULxRdyTX+QEYjV65GnCHANBQO3541r8nWe4HYHSip+yJHrOjQ6sBnQgAO8qz/okiqXkwhlJKqTHVYDVgR0dWAyZb3vi37XDWD0DFqwE7VlYDWv1NgdYGgB0rd29aSq71A1C96D1LO1p8J8FWBoAdK9/r7zvrB6Dm1YB+2ZMEgDE3/uGS/5zPHQANMdfGSwKtCQA7Vu7T7Ot9ADRR9KbFHS16pkArAkAxoLellSX/aZ8xABoqelS/7FkCwJab/9yx3Wk5zRc1VVRSSimlGlzRq+YHvUsA2FLzj6f3zQmVALTMXNnDBIANNv5tRcVmv1mfIQBaajZ6WfQ0AWCdzT+tXO/v+ewA0HLRy/pNDAGNCgCrmv+MzwwAHTHTxBDQmABww9yx6yeKASpqxv2mlVJKdayit/Wj1wkAZzR/Z/4A5LAS0JQQUHsAWNX83dYXgK6bakoIqDUA3LByPWRe8wcgsxAwf0PNewJqCwA32PAHQL6GlwNqCwG1BADNHwDqDQF1rQAc0vwBYNALD2URAG5YuTViz3sOAAO9G2q4bXClAeCGlYcjzHqvAeA0szdU/AChygJA8cLi8Yhz3mMAOKu5sld2JwCU33fc470FgHPaU9U9AsYeAMrdjbHBwXf9AeDcolcequKbAVWsAETzn/aeAsC6TKcKvhkw1gBw4+5juyeWU6+opJRSSql1Vy96aCsDQPGD35hs+gOAzZore2l7AkDxA29LNd3YAAA65FDZU1uzAmDTHwBs3dS4TqhHHgCKpHJHcqc/ABiVXtlbmxsAih/wmuS6PwCM2lzZY5u6ArA8X9RUUUkppZRSI6uplR7bwABw4+6jlv4BYHx6Za9tTgAofiBL/wAwfnNlz23MCsB8susfAMZtquy59QeAIonckiz9A0BVemXvrS8AFD9A3JzAU/4AoFp7yh5c2wrAruRBPwBQtemyB1cfAHq7j14zUfzlRSWllFJKVV67elvYELiVFYC5ZOMfANRlKm3hG3ibCgBF4ri++J9ZYw8AtZote3JlKwA2/gFAM2yqJ284ABRJI55N3DPeANAIvbI3j30FYM5YA0CjbLg3bygA9O4qEsZycfbvuQxKKaVUk6o36NFjXAFw9g8AHVgFWHcAKJJF7DLsGV8AaKRe2atHvgKwy9gCQKOtu1evKwAUiSLuNDRrXAGg0WbLnj2yFQBn/wDQoVWA8waAm+4aPG3I2T8AtGQVoOzdW14B2DmR0pSHLiillFKtqHhGwM5RBADL/wDQLuft3ecMADetfJ1gxjgCQKvM3HSerwSebwVg1hgCQCvNCgAAIACsLwDcdNfRW9LKRgIAoH2myl6+4RWAncYOAFptpwAAAALAuQOA5X8A6IQ1LwNMOvsHgPxWAQQAABAAUrrps0dvTMtpqqiklFJKqdbX1KC3r2MFwNk/AHR8FeBNAWAipZ4HKSillFKdqt45A8DNnz16TXLvfwDompmyx6+5AtAzRgDQST0BAAAEAAEAALINAOW1gWnjAwCdNL16H8DqFQCb/wCg22YEAAAQAAZ6xgUAOq1nBQAAcl8BKDcFePwvAHTb1HAj4HAFYNqYAEAWpt8IAO7/r5RSSuX1XAArAACQ6wqAAAAAeQYA3wAAgDzM/DAALKepopJSSimlOl+Db/1NfuAzR28UhgAgH9H7Jw0DAOQnAoDr/wCQl5kIAO4ACAB5mXIJAAAyFAGgZxgAICs9KwAAkOkKAACQWwCYSGnKgxGUUkqprGrK1wABID8zLgEAQIYEAAAQAAAAAQAAEAAAAAEAABAAAID2BIDl4lellFJKZVVWAAAgyxUAAEAAAAAyCAAeiKCUUkrlV1YAACDHFQBDAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAIAAAAGMNAB6IoJRSSnkYEACQwwpAWi5+VUoppVRWZQUAALJcAQAABAAAQAAAAAQAAEAAAAAEAABAAAAABAAAQAAAAOoLAB6IoJRSSnkYEACQwwqAIQAAAQAAEAAAgI4GAA9FVluvq6dSes+1k4N6749PpltvvlApNaKKY2p4fMWxZs5RoygrAGzYdW+fTDvf95Z018cuTvf/+0vS1/7T5engr1+W7vnFSwa1+9ZL0q0fuFApNaKKY2p4fMWxFsdcHHtxDMaxGMckbHwFQAhS66j3/vgF6dc+clH6o89clvb+yqXpEx++OL3vXW9J7/yRCxxFUIM49uIYjGMxjsk4NuMYjWPVnKXWU2Ija7p6aiL90oeLpv/ZywZnIB/6yQvTWy+dMDDQQHFsxjEax2ocs3HsxjEMa68AwFkaf5xJHPyNy9LP/pSmD20MA3HsxjEcx7IggADAuhv/h/7VhQYEOiCOZUEAAYA1xUai+3/lUo0fOhwE4hiPYx0GAcD9kPOuOCOIncWf+OmLLfVDx8UxHsd6HPNx7JsDPQuATH3wJ1fO+t9znZ38kJM45uPYjzmAjFcADEGePv7hi9KvfdRZP+S8GhBzQMwFCABk4lMfuWiwQxgg5oKYExAA6LDLL0np8794iY1+wGliToi5IeYIBAA66K5bL3G9HzirmBtijkAAoGNiiU/zB84XAlwOEADokNjkY9kfWI+YK2wMFADogHgwiA1/wEbEnDF4qBACAO20fWoifeqjFxsIYMNi7tju1sECAO3ke/7AZg3vE4AAQMvE/b5t+gO2IuYQzw4QAGiR+C7vxz5gEw+wdTGXuD9ARwPAxHJKqlv1Sx++yNI/MBIxl8ScYm7tXlkB6JjYtOMrf8AoxZxiQ2AHVwAMQceW6z6o+QPmFgQAZ/8AVgEQALp+gNqtC5hjEACy80EHJ2COQQDIy7951wXp6rd5O4HxiTkm5hoEABrkvQ5KwFyDAJAfd/0DzDUIAJm57kcmLf8DlYi5JuYcBAAa4F9c520EzDkIAFmuAACYcxAAMmP5HzDnsOEAEPd1Uu0um3KAKsWcY+5tf4lxLecxnYC5h02tABiCdnMtDjD3IAAAAAIAACAAAABvBIDl4lfV3gKoizm41WUFAACyXAEAAAQAAEAAAAAEAABAAAAA2hkAPBCh/QVQNXOvhwEBAG1cATAEACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAABQZwBYLn5V7S6Aqpl7W19WAAAgxxUAD0TwICCAzTAHexgQANC2FQBDAAACAGTn6A9eT08dfiX95Z8fS19+6B8H9ZXHfjD4Z8///audf63x/+Ofxb/rknjv4nXFe9n11woCAGygOTyw7+V05yefTx/7yN+nz/zG/02//7tH0pe/9I+DeuCL/2/wzz5+2/Pp4z//XPr9L7w0aBxt9PTfnhq81ngdZ3ut8f/jn8W/i98Tvzf+mzaK9yjeq3gd8d7F64r38myvNd77eK1dC3kgAMAajf+3514cNIevHDqanv5f55/8n3/utfSXf3F80DiiabQlCMTP+Zlf/4d05y+/MHit8TrW81rj98Z/E/9tm15rvDfxHsV7tZ7XGu99vNb4LMRnQhBAAICOGpwFF5P9E//zxObPpoumEU0mGkZTl5Hj54qz4Pg5n/rOyc031eK/HawWFH9Wk19rvBfxc64nzK0lPhPx2YjPCAgA0BHRJOLsMM72RmXQMH7+ucYtlcfPE2fvcRY8KvFnxZ/ZxNca78FWAt2ZBqsfxWfFHgEEAGi5YZPYytnhmsHi6PJKs/3zY415rbFsv57l742KPzP+7KaEgBjzGPt4D0Y+jsVnpYnhDgQA2MCZ/2/f/eJYmsRqsbGs7mYxbP7jfK3xZzchBMTfH2M+1s9O8VoHnx0rAQgA0D7jOhte8++qaRNZVUGnCY0xxjjGupK/q1z1AAEAWiS+8z2OZf9zNcZxn5We67VWFXSGjTH+zjrEGFcRdN5YbSg+Q3W9Vhh7AHA/ZM8D6Jo4S4zvfFctds0/8VfHq/0740Y3I9zcuF7xd1b9FcEY2618q2HTAav4LPmK4JuZez0LAJp39v+l+s7Y4qYzubzWqv/uqse2KeMMY1sBMAR0SVybHuVX4Da8+vDca5WtAgxudVvDGfHqFY+qzoxjTKu8zHGm+EzZEIgAAA32xF+dyOZn+MpjR2t/rVX9DDm9r1BdAIj9NKrdRZaN4qnv1H+b3qp+BgGggcy9rS8rAHRKE5pi7FIf93flYzm6ym85rCV+hnEvjcdYVrnzv8mfLRjtCgB0RFyPbkKjGPwsz423OTfpLnXj/lnGPZYbCXa+DYAAAE0MADVuEntzU9QoujiWTfqMgQAAGapz93+TfxZAAAAABADolne/5yI/CyAAQLj2nRc26Gd5izekg2PZpM8YCABQuvytk+nyy5vxdITtV4+3ab37+oubswIw5p9l3GO57s9X8dmKzxh0JgB4IIKHAXXJu99Tf2OMRlHFmeK119XfGKv4GWIsmxDsmvDZahJzr4cBQaP86/ddks3PcPO/vaz211rVz5DT+wqVrQAYAroWAOo+W7z5QxU1xfc2oClW9DNUNaZric+UAIAAAA0W12jrnKhjR3xV1+e3v/0ttYaA+LvjZ6hkXIsxrfPbBoNg6fo/AgA02y98YlttqwA/d+s/qfi1XlHjOF/R6bFdffYfnykQAKAFqwA/9++qbxZxRlz17vw4A/+ZnZdX/lrj76zq7H/1KkAdKx7xWXL2jwAALfEzP/vWSpeM4yzxVz89VctrjQZV5TcC4u+qI2CFGOMqV3fiMxSfJRAAoEX+w+4rK2mM0ZB+63f+WW1nifH3xmutojHG3zH4u2p8rYOxruC1xmcnXisIANAyw2YxzhAwbP513yEuluPH3RiHr7Xqpf83NeZirMf9WuMzU2eog2oCQDw+XbW3WFcIGMflgO1XX9CI5r+6Md6796qxBJ74Mwd/doNe6yCMFO/BqMVnRfNfJ3Nwq8snvAsHIOsKAbGLfFRnjTd/6NJGNcTVKwH37ts+0o2B8WfFn1n3mf9agSfei1GtcMRnRPM39+SzAgCZiI1rW20Yg7PDe/5p+tVPv63RTeIXPrkt/cHB7Vt6rfHfxp8Rf1aTw128F/GebGWVZxjo6trcCAIAVHCGHA3j4T9+++B77OtpGrH8HWfB0QwHlxOuv7hVr3XQxNf5WuP3xO+N/yb+26ad9a/5cxfvSbw38XPHe7WeyyDD1xqfhTa9VhhZAPBABA8DylGcOcbXu6JpHPr6jw7O/uIs8swa/Lt9K2fBbW0Qg3sFrHqtZ3udw9cavyd+b5tfa7xX8Z6t9VrjvV79Wi33b46518OAoBPievLgdrNnVBed7XXm9Fqbtm8DalsBMAQAIAAAAAIAACAAAABdCQBuh+RWgACbYQ5uc1kBAIA8VwAAAAEAABAAAAABAAAQAACAVgYAD0TwICCAzTAHexgQANC2FQD3QkjuAwSwGebgVpcVAADIcgUAABAAAAABAAAQAAAAAQAAEAAAAAEAABAAAAABgJHwPADA3MOmAoAHIngYEMBmQ4DyMCAAoE0rAIag3Z5+9jWDAJh7EAByc+yEMQDMPQgAWXrqbyVxwJyDAJCd51983SAA5hwEgNx8TxoHzDlsOAAsF7+qVpflOKBKgznH3Nv6sgLQAS+8uGxJDqhEzDUx59CFFQA64YmnXjUIgLkGASA333jSQQmYaxAAsrP0d6+7DACMVcwxMdfQkQDgfsjdKckcGPfZv7nWswBooD/55kmDAJhjWN8KgCHojrg15zeePGUggDGc/Z9y+18BgCb7r1+X0AFzCwJAdl54adkyHTBSMafE3IIAQAuS+tHjDlZg62IucfYvANAScZ1u/6FXDASwZTGXuPYvANAi/b9+NT31fc8IADYv5pCYSxAAaJnPHzjuUgCwKTF3xByCAEALxbLd5w9YuwM2cwJxwtK/AECbxXO77QcANiLmjO95zLgAQPt99X+ccoMgYF1irog5AwGAjrjvy68IAcB5m3/MFWQSACaWU1J51P2PFiHgW0IAcJbmX8wNMUeYK/MpKwCZuf/LQgBwlubvzD+/FQBDkGcIOGBjIFCIuUDzFwDIyFe/eSrtvt99AiBXcezHHBBzAQIAmYmv+Xzyc0fTt77rTl+Qkzjm49j3VT8BgIzFjT7uOXAifX6/1QDI4aw/jvV73OQHAYChJ59aWQ34b576BZ0Ux3Yc43GsgwDAm1YDhpNE7Aq2IgDtP+OPY3kY7p31IwBwTi+8tDzYFRyTRuwQfv7F1w0KtEgcs3HsxjEcx3Ic0yAAsKEVgdgh/Mu/dSx9+gvH0p8snBQGoMFNP47ROFbjmI1j1xk/AgBbtvR3r6f5x08OJpY4q7jv0RODyeZ733/NpQKoWBxzcezFMRjHYhyTcWzGMRrHKggAjEUsJ/affHUw2ezeezzd9h+Ppo9+6geDM4/4XvFWqis3KIrJeatjodSZFcdYHGtxzMWxF8dgHIuW+BEAqH2VIL5XvJVaerb9Zy9PP/taumf/8S2PhVJvOj6c3TPKADBR/KJUU2r7lROtX5rd++grg2uv3k+lVJPLCgCNctWV7f5I3rP/hLM0wCUAyMn9j55If+PWqoAAAPmIm63EZiwAAQAyEQ9W2etxqoAAAJv3E++8oFU/b+z4j6V/gPYFgPj6qFJNqRaJHf+/88CJdOy4900p1b6yAgCbNHffcTdgAVq8AgBs2P2P+LofIADAyFx2afN/xq8unLTjHxAAYJSufUezNwHGjv/5Qye9UYAAALkY7Ph/xI5/QACAbLyx41//B7oSADwQQTWpmtr8Y8f/P7y07D1SSnkYEIzaNT/azI/j/GOvpGfs+Ae6tgJgCGiKyy9t3hrAH37tZFqw4x8QACAf/W+dSn/4dTv+AQEAsrH07GuDpX8AAQAyMdz0Z8c/IABABX7ix+q/CZDmDwgAkCE7/gEBADJjxz8gAEBm7PgHBACoyVVX1nMfgNjxv/dRO/6B3ALAcvGrUg2oq66sPo8+/+Lrg01/xl8plVtZASBbseP/C/GAn+PGAshwBcADEVSuDwLa+8iJ9Myzrxt7pZSHAUEu4ut+f/3d1wwEkO8KgCGgKabfUc3HMXb8/9nCKQMOCADQBFU8DTB2/O97xI5/AAGAbMSO/7vvs+MPQAAgG3b8AwgANNBll473z4/mHzv+ARAAaJDpd4zvSYDxdb+/+b4d/wACANmIHf8L3/KAHwABgGx87/t2/AMIAGQlvu73hQfs+AMQAGi0UT4JMHb87y3O/O34BzhHAHA/ZNWE2j7CJwH+7gMn0v92j3+llPIsAPKxz45/gPWtABgCumLBjn8AAYC8PPndV+34B9hQAFguflWq5nrXOzd/I6Cl//Na2vfwCeOolFIbKCsAtNrRY8uDTX92/ANsdAVADFKNqY37zfuOpRdefN3YKaXUBssKAK217+HjHvADsPkVAKjfZZdu7EZAf9o/acc/gABA203/8/VvAnzyO6fSg4/Z8Q8gAJCNwY7/R04YCAABgFys7Pg/bsc/gABATs1/Zcf/ssEAGEUA8EAEVXdNv+P8OfTBxzzgRymlPAyITjnfNwD+6M9eSd+04x9gtCsAhoAmW3jiVPrjr500EAACALmIHf+x9A+AAEAmYtPf5+47Zsc/gABAV73rxy7Q/AEEAHIXy/7u8Q8gAJARO/4BBAAyY8c/QJUBwCORVc111ZWTgx3/X3z4hPFQSqmKygoAjfC5/3zMIABUugIANXvwv5+w4x9AACA3mj9ADQHAAxGUUkopDwMCAHJYATAEACAAAAACAAAgAAAAAgAAIAAAAAIAACAAAAACAAAgAAAAAgAAMNYA4IEISimllIcBAQA5rACk5eJXpZRSSmVVVgAAIMsVAABAAAAABAAAQAAAAAQAAEAAAAAEAACgwQFg0TAAQFYWIwAcMQ4AkJUjHgaklFJKJQ8DAgAyEAGgbxgAICt9KwAAkOkKgE2AAJCXI74GCAD5WXQJAAAyNPnwfVcspOXi/ymllFIqi4reP1wBsA8AAPIw6PnDAGAfAADkYXF1AFgyHgCQhSUBAAByDgATKfXdF1kppZTKovpWAAAg5xWAL91/xTPJNwEAoOuOlD3/tKcB+iYAAHTbG71+dQDoGxcA6LT+2QKAFQAAyHAFQAAAgNwCQLkpYMnYAEAnLQ03AJ65AhD6xgcAOum0Hi8AAIAAIAAAQHYBoLw2YDMgAHTL4urr/2dbAbAKAAAdP/s/awCYWE6HikpKKaWU6kwdOm8AeGjvFQvJcwEAoCuOlL393AGgdMh4AUAnnLWnCwAAIACseGjvFY8nlwEAoO2OlD193SsAVgEAoKNn/wIAAAgAp3MZAABabc3l//OtAIR54wcArXTOHi4AAIAAcLqH9l5xOHk2AAC0zWLZwze9AhD2GEcAaJXz9u71BIDYQWgzIAC0w5G0jm/ynTcAPLT3ipcnUpovKimllFKq8TUfvXsUKwDrWkoAABphXT17XQHgwb1XPJN8IwAAmm6+7NmjCQBWAQCgO2f/GwoAD658naBvbAGgkfoPnuerf5tdAQhzxhcAGmlDPXpDAaBIFgtpOfWLSkoppZRqTPUHPXpcAcAqAAC0/+x/UwHgwX2DhNE31gDQCP2yN483AJR2GW8AaIRN9eRNBYAiacQuw3ljDgC1mi97cjUBoDSXPCMAAOpyJG1hX96mA0CROOJOQ24OBAD12FP24moDQJgo/vKiljx4QSmllKq0ovdu6SR8SwHg4L7B04ZsCASAau0qe3A9AaAMAY8nXwsEgKr0y967JZMj+mFmkw2BADBuR8qeu2UjCQAHVzYhzHlfAGCs5g5uYePfOFYAIgT8XkrLfTdkVkoppcZS/ZVeOxqTI04ms8mlAAAYtZEt/Y8lABzct82lAAAYvbmyxzYzAJQhIJYn+t4rABiJftlbR2pyTD/szuRSAABs1ZGyp47cWAJAkVReHtcPDAAZ2Vn21HYEgDIELKTlNGfTplJKKbWpmhv00jGZHGdsOfjFbXcn+wEAYKP6ZQ8dm8lxv4KJlHZ6YJBSSim1oQf9jP0y+tgDwPwX39gPYFMgAJzbYNNf2TvbHQDKEHA4eWogAJzPrrJnjt1kVa+oeEEHk5sEAcBa5speWYnJKl/Z/MqGhnnvMQCc3iLnx7zpr9YAUIaA25NvBgDAUL/sjZWarOnFxqbARe85AJlbTDXdOK+WAFDubuwJAQBk3vx7Vez4b9IKgBAAgOZfU/OvNQCsCgGzyT0CAMhH9LzZOpt/7QGgDAGHy5UAIQCAHJp/r6rv+jc6AJwRAlwOAKCrFpvS/BsTAIYhYKIYmKIW3QdaKaVUxyp6W2Oaf6MCQDhgYyAAHT3zP1DzNf9GB4AzQkDfZwaAlus3sfk3MgAMQ0BRNyW3DQagveajlzWx+Tc2AKwKAren5TRXVFJKKaVaVHMHari9b2cCwCAE/JfBwxFmk68JAtB8g+/4l72r0SbbMJrFQMbjEXtFLflsAdBQ0aN6Zc9qvMm2jGoxoPHViZlkcyAAzRO9aabsVa0w2abRLQb25aJic+CczxoADTEXvSl6VJt+6Mk2jnR5baWX7AsAoD6D2/q24Xp/ZwJAGQIWiv+ZTi4JAFC96D3TZS9qpck2j/6qSwK7rAYAUNFZ/642Lvl3KgCsCgK/l2wQBGD8Z/0zZc9pvcmuvCvFG/JMJLKJIpkVdcSDJ5RSSo2ooqcMz/qf6Urf7EwAGNpvNQCAEZ/17+/IWX+nA0AZAp7Zv7I3YGdy8yAANi56x87oJfs7dNbf+QCwKgg8Xq4GzCWbBAE4vyNlz5gpe0hnTXb9nSzewJf3r3xHM4LAvM82AGuYLxv/3ftbvsNfADg9CMRlgduT/QEAnK5fNv7bu7rcn3UAWBUEDpf7A3qCAED2jb9XXuc/nNuLn8z1XS/e7AVBACD7xr+Q6yBM5v4pWBUE7BEA6LaY42dyb/wCwJuDwOFyj8B0UXvScjpSVFJKKdXqOjKY04u5vbzGf1jHEwDWCgKxWfDOMgjMFrVoVABaZ7Gcw6Px35nT5j4BYKtB4A+2vVzUwaL+ZVq5PBAJ0r0EAJpreLY/E3N3OYe/bFgEgK2EgcNF3VnU29LK3QXnhQGAxjT9mJN3xhxdztWW+QWAsYSBx4u6PT5oE8UHrqh5Dx9SSqnKH84Tc++w6cec/LgOJQBU5oHiA1fU7Q+srAz0yqUnewYARm+xnGN7MeeWc6+mLwA0IgwsFHXnAyt7BqbTyuaTWJZaMjoAG7ZUzqExl07H3FrOsQuGRgBochh4pqiDZUK9tgwEsXdgLq3cgML+AYAfOlLOjXPlXBkN/9pyDo251A5+AaDVgSAuF9xd1E3lJYMIBb3yAz8vGAAZNfr5cu7rlc3+beXceHc5V2r4AkDnQ8FC+YG/fRgMipooD4qoXeVBMlw5GJZ9BkCTLJ4xRw3nrV3D+SzmtlWN/vZy7lvQ7Ovz/wFqS3sSlQ1ilQAAAABJRU5ErkJggg==',
  '/icon-maskable-512.png': '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',
};

const PNG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

const MANIFEST_HEADERS = {
  'Content-Type': 'application/manifest+json;charset=UTF-8',
  'Cache-Control': 'public, max-age=3600',
  'Access-Control-Allow-Origin': '*',
};

// SW 必须挂在根路径，并显式声明 scope；no-cache 保证新版本能及时下发
const SW_HEADERS = {
  'Content-Type': 'application/javascript;charset=UTF-8',
  'Service-Worker-Allowed': '/',
  'Cache-Control': 'no-cache',
};

const HEALTH_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

// 解码结果缓存，同一 isolate 内只解一次
const iconBytesCache = new Map();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getIconBytes(pathname) {
  if (iconBytesCache.has(pathname)) return iconBytesCache.get(pathname);
  const b64 = ICON_B64[pathname];
  if (!b64) return null;
  const bytes = b64ToBytes(b64);
  iconBytesCache.set(pathname, bytes);
  return bytes;
}

// PWA 缓存版本号 = 前端页面 + SW 源码的内容哈希。
// 好处：只要改了页面或 SW，版本号自动变化 → 浏览器触发更新 → activate 清掉旧缓存。
// 因为它是纯函数（只依赖源码文本），isolate 重启后依然稳定，不会导致 SW 反复更新。
let cachedPwaVersion = null;
function getPwaVersion() {
  if (cachedPwaVersion) return cachedPwaVersion;
  const s = HTML_CONTENT + SW_JS;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  cachedPwaVersion = (h >>> 0).toString(36);
  return cachedPwaVersion;
}


function parseCommaSeparated(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// 定长比较，避免通过响应耗时逐字节猜解口令
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// /api/chat 访问口令校验
// 未配置 ACCESS_PASSWORD 时返回 null（直接放行，行为与从前一致）；
// 配置后要求请求头 X-Access-Token 与之一致，否则返回 401。
function denyUnauthorized(env, request) {
  const required = env.ACCESS_PASSWORD;
  if (!required) return null;

  const provided = request.headers.get('X-Access-Token') || '';
  if (safeEqual(provided, required)) return null;

  return new Response(JSON.stringify({
    error: "访问口令错误或未提供",
    code: "UNAUTHORIZED",
  }), { status: 401, headers: CORS_HEADERS });
}

// ======= 按 IP 滑动窗口限流（isolate 级内存，轻量防刷） =======
// 环境变量 RATE_LIMIT_PER_MIN：每 IP 每分钟允许的 /api/chat 请求数，默认 60；设为 0 关闭。
const rateLimitMap = new Map();
function hitRateLimit(request, env) {
  const perMin = parseInt(env.RATE_LIMIT_PER_MIN || '60', 10);
  if (!(perMin > 0)) return false;
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
  const now = Date.now();
  let arr = rateLimitMap.get(ip) || [];
  arr = arr.filter(t => now - t < 60000);
  if (arr.length >= perMin) return true;
  arr.push(now);
  rateLimitMap.set(ip, arr);
  if (rateLimitMap.size > 5000) rateLimitMap.clear(); // 防止 Map 无限增长
  return false;
}

// ======= Telegram 多轮对话历史（内存 L1 + R2 L2） =======
const tgHistories = new Map();
// update_id 去重缓存（v6.6.3 起改用内存，不再写 R2）：
// key 为 Telegram update_id，value 为首次见到时间戳；
// 去重窗口 10 分钟，每次 webhook 顺手清理过期条目，Map 不会无限增长。
const seenUpdateIds = new Map();
// v6.8.1：TG_WEBHOOK_SECRET 缺失告警，每个 isolate 只打一次
let warnedNoWebhookSecret = false;
function tgHistoryKey(chatId) { return 'tg_hist_' + chatId; }
function tgTrimHistory(history, env) {
  let maxRounds = parseInt(env.TG_HISTORY_ROUNDS || '10', 10);
  if (!(maxRounds > 0)) maxRounds = 10;
  if (maxRounds > 30) maxRounds = 30;
  const maxMsgs = maxRounds * 2;
  while (history.length > maxMsgs) history.shift();
  // 字符预算：超长历史从最旧开始丢弃，保证单次请求可控
  const budget = 12000;
  let total = 0;
  for (let i = 0; i < history.length; i++) total += String(history[i].content || '').length;
  while (history.length > 2 && total > budget) {
    const dropped = history.shift();
    total -= String(dropped.content || '').length;
  }
  return history;
}
// ==================== 持久化层：R2 ====================
// v6.3.1 起彻底移除 KV，只用 R2：无日写入上限（免费版每月 100 万次 A 类操作）、
// 单对象可达 5TB、读写强一致。未绑定 R2 时退化为纯内存
// （isolate 重启丢失；Telegram 机器人需要持久化，请务必绑定 R2）。
//
// ---------- R2 文件夹布局（v6.6.6 起，v6.6.7 补充 md 镜像） ----------
// R2 没有真正的目录，用 key 前缀 + '/' 模拟文件夹，控制台按此展示层级。
// 「知识库」（Agent 长期记忆）独立存放在 kb/ 文件夹下，与其它数据隔离，
// 便于在控制台单独浏览、备份或设置生命周期规则；其余数据保持原样不动。
//
//   kb/agent_mem_<chatId>   知识库索引：长期记忆 JSON 数组 [{fact, ts, file}]（唯一可信源）
//   kb/mem/<chatId>/*.md    知识库镜像：每条记忆一个 Markdown 文件（frontmatter + 正文），供控制台浏览
//   kb/docs/<标题>.md       知识库文档：save_doc 工具写入的长篇 Markdown（全局共享）
//   kb/docs/registry.json   文档注册表：标题/来源/大小/时间的索引（去重与列表的唯一依据，损坏自动重建）
//   tg_hist_<chatId>         Telegram 对话历史（根目录，保持原样）
//   tg_user_<chatId>         用户模型选择（根目录，保持原样）
//   agent_mode_<chatId>      Agent 开关（根目录，保持原样）
//   tg_agent_<chatId>        Agent 断点续做（根目录，保持原样）
//
// 注意：md 镜像只是"可读副本"，机器人只读 JSON 索引。手动在控制台改 md
// 不会生效；以索引为准，缺失的 md 会在下次加载时自动补建。
const KB_PREFIX = 'kb/';
function agentMemKey(chatId) { return KB_PREFIX + 'agent_mem_' + chatId; }
function agentMemKeyLegacy(chatId) { return 'agent_mem_' + chatId; } // v6.6.5 及更早的旧 key（根目录），仅用于兼容迁移
// chatId 清洗：只允许字母数字、下划线、中划线，防路径遍历（如 ../）污染 kb/mem/ 目录
function kbSafeChatId(chatId) { return String(chatId == null ? '' : chatId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64); }
function kbMemDir(chatId) { return KB_PREFIX + 'mem/' + kbSafeChatId(chatId) + '/'; }
// md 文件名：时间戳（36 进制，可按字典序排列）+ 随机后缀防同毫秒碰撞
function kbNewMemFile() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.md'; }
function kbMemMarkdown(chatId, fact, ts) {
  let d = '';
  try { d = new Date(ts || Date.now()).toISOString(); } catch (e) { d = new Date().toISOString(); }
  return '---\nchat_id: "' + kbSafeChatId(chatId) + '"\nsaved_at: ' + d + '\n---\n\n' + String(fact == null ? '' : fact) + '\n';
}
// R2 批量删除（delete 支持字符串数组，一次最多 1000 个）
async function kbDeleteKeys(env, keys) {
  if (!env.R2 || !keys || !keys.length) return;
  try { await env.R2.delete(keys.slice(0, 1000)); } catch (e) {}
  if (keys.length > 1000) await kbDeleteKeys(env, keys.slice(1000));
}
// 清空某用户的整个 md 镜像目录（删 Web 会话时用）
async function kbDeleteMemDir(env, chatId) {
  if (!env.R2) return;
  try {
    const prefix = kbMemDir(chatId);
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: prefix, cursor: cursor, limit: 1000 });
      const keys = (listed.objects || []).map(function (o) { return o.key; });
      if (keys.length) await env.R2.delete(keys);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {}
}
// 回补 md 镜像：给缺 file 字段的老条目分配文件名，并补建 R2 里缺失的 md 文件。
// 返回 true 表示索引数组被修改过（调用方需重写索引）。
async function kbBackfillMd(env, chatId, arr) {
  if (!env.R2 || !Array.isArray(arr) || !arr.length) return false;
  const dir = kbMemDir(chatId);
  let indexChanged = false;
  const need = [];
  for (const m of arr) {
    if (!m || !m.fact) continue;
    if (!m.file) { m.file = kbNewMemFile(); indexChanged = true; }
    need.push(m);
  }
  if (!need.length) return indexChanged;
  // 查目录找出 R2 里缺失的 md（分页取全量，避免逐个 HEAD；超 1000 条也 OK）
  const existing = new Set();
  try {
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: dir, limit: 1000, cursor: cursor });
      for (const o of (listed.objects || [])) existing.add(o.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {}
  const puts = [];
  for (const m of need) {
    const key = dir + m.file;
    if (!existing.has(key)) puts.push(storePut(env, key, kbMemMarkdown(chatId, m.fact, m.ts)));
  }
  if (puts.length) await Promise.all(puts);
  return indexChanged;
}
async function storeGet(env, key) {
  if (!env.R2) return null;
  try {
    const obj = await env.R2.get(key);
    if (obj) return await obj.text();
  } catch (e) {}
  return null;
}

async function storePut(env, key, value) {
  if (!env.R2) return;
  try { await env.R2.put(key, String(value)); } catch (e) {}
}

// v6.8.3：带成功返回的 R2 写入。storePut 静默吞错，只用于"尽力而为"的场景；
// 知识库/记忆写入必须诚实——没存上就要让 Agent 知道，而不是谎称成功。
async function storePutChecked(env, key, value) {
  if (!env.R2) return false;
  try { await env.R2.put(key, String(value)); return true; }
  catch (e) { return false; }
}

async function storeDelete(env, key) {
  if (!env.R2) return;
  try { await env.R2.delete(key); } catch (e) {}
}

async function tgGetHistory(env, chatId) {
  if (tgHistories.has(chatId)) return tgHistories.get(chatId);
  const raw = await storeGet(env, tgHistoryKey(chatId));
  if (raw) {
    try {
      const h = JSON.parse(raw);
      if (Array.isArray(h)) { mapSetBounded(tgHistories, chatId, h); return h; }
    } catch (e) {}
  }
  return [];
}
async function tgSaveHistory(env, chatId, history) {
  mapSetBounded(tgHistories, chatId, history);
  await storePut(env, tgHistoryKey(chatId), JSON.stringify(history));
}
async function tgClearHistory(env, chatId) {
  tgHistories.delete(chatId);
  await storeDelete(env, tgHistoryKey(chatId));
}

// ==================== Telegram Agent：工具定义 ====================
// 全部工具零密钥、零成本：DuckDuckGo（搜索）、任意网页抓取、自研计算器、
// Open-Meteo（天气）、Intl（时间）、R2（长期记忆）、R2（知识库文档存取）。
function getAgentTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。仅在需要时效性内容（实时新闻、价格、股价、赛事结果等）或问题超出你知识范围时使用；稳定的常识性知识不要搜，直接回答。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'integer', description: '返回条数，1-8，默认5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取指定网页的正文纯文本，用于总结文章、阅读文档页面（返回清理后的文本，可能截断）。只对搜索结果中或用户明确给出的 URL 使用，不要猜测/编造 URL。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '完整的 http(s) URL' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '精确数学计算，支持加减乘除、乘方(^)、取余(%)、括号。任何需要数字运算的场景（哪怕看起来简单）都用它，不要心算。',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: '如 (3+5)*2^3/4' } },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前时间，可指定 IANA 时区。用户问"现在几点/今天周几/日期"之类时使用，不要凭记忆回答时间。',
        parameters: {
          type: 'object',
          properties: { timezone: { type: 'string', description: '如 Asia/Shanghai，默认 Asia/Shanghai' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市当前天气与今明两天预报。city 必须给明确城市名（如"北京"、"Tokyo"）；用户没说城市时先追问，不要猜。',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名，如"北京"、"Tokyo"' } },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把关于用户的重要长期信息存入记忆（如偏好、生日、项目名、常用城市），存入后以后所有对话都会记得。仅在用户明确要求记住（"记住…"）时调用，不要把临时对话内容存进去。',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: '一句话事实' } },
          required: ['fact']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_doc',
        description: '把长篇内容保存为知识库文档，真实写入 R2 的 kb/docs/ 文件夹（文件名取自标题）。仅在用户明确要求保存文档（"保存成文档/存到知识库/生成知识库文件"）时调用；简短的个人信息用 remember，不要用它；不要主动为普通回答生成文档。只有本工具返回成功，才可以告诉用户"已保存/已生成"；失败或没调用时绝不声称已保存。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '文档标题，用作文件名，如"甲骨文云ARM放货知识库"' },
            content: { type: 'string', description: 'Markdown 格式的正文' },
            source: { type: 'string', description: '可选：原文链接，会记入文件头' }
          },
          required: ['title', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_docs',
        description: '列出知识库文档（R2 kb/docs/ 下所有文档的标题）。用户问题可能涉及之前保存的文档主题时，先调用它确认有没有相关文档；有则用 read_doc 细读。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '按标题关键词读取一篇知识库文档的全文（超 8000 字截断并标注）。query 给标题或关键词，模糊匹配；标题想不起来时会自动改搜正文并返回关键词附近片段；找不到时会返回现有标题列表。读到相关内容后优先引用，并注明"据知识库文档《xxx》"。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '文档标题或关键词，如"甲骨文ARM"' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_doc',
        description: '删除一篇知识库文档（R2 kb/docs/）。仅在用户明确要求删除文档时调用；query 给标题或关键词模糊匹配，找不到会返回现有标题列表。删除不可逆，调用前确保用户意图明确。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '文档标题或关键词' } },
          required: ['query']
        }
      }
    }
  ];
}

async function execAgentTool(name, args, env, chatId) {
  // 兜底超时：单个工具最长执行时间，防止 abort 信号无法中断 hung 住的请求体
  // （如永不结束的流式响应）。可通过 AGENT_TOOL_TIMEOUT_MS 调整，默认 30 秒。
  let toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
  if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  let timer;
  try {
    const run = (async () => {
      switch (name) {
        case 'web_search': return await toolWebSearch(args.query, args.count);
        case 'web_fetch': return await toolWebFetch(args.url);
        case 'calculate': return toolCalculate(args.expression);
        case 'get_time': return toolGetTime(args.timezone);
        case 'get_weather': return await toolGetWeather(args.city);
        case 'remember': return await agentSaveMemory(env, chatId, args.fact);
        case 'save_doc': return await toolSaveDoc(env, chatId, args);
        case 'list_docs': return await toolListDocs(env);
        case 'read_doc': return await toolReadDoc(env, args);
        case 'delete_doc': return await toolDeleteDoc(env, args);
        default: return '未知工具: ' + name;
      }
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('__TOOL_TIMEOUT__')), toolTimeoutMs);
    });
    return await Promise.race([run, timeout]);
  } catch (e) {
    if (e && e.message === '__TOOL_TIMEOUT__') return '工具 ' + name + ' 执行超时（' + Math.round(toolTimeoutMs / 1000) + ' 秒），已跳过';
    return '工具执行失败: ' + (e && e.message ? e.message : String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// DuckDuckGo HTML 结果解析（抽出以便测试）
function parseDuckDuckGo(html, count) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // 摘要与标题在页面中按相同顺序出现，按序配对
  const snips = [];
  const reSnip = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let sm;
  while ((sm = reSnip.exec(html)) && snips.length < count) {
    snips.push(sm[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    try { if (uddg) href = decodeURIComponent(uddg[1]); } catch (e) {}
    const title = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title && href && href.startsWith('http')) out.push({ title, url: href, snip: snips[out.length] || '' });
  }
  return out;
}

async function toolWebSearch(query, count) {
  query = String(query || '').trim();
  if (!query) return '搜索关键词为空';
  count = Math.min(Math.max(parseInt(count) || 5, 1), 8);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: ctrl.signal
    });
    if (!res.ok) return '搜索请求失败，HTTP ' + res.status;
    const html = await res.text();
    const out = parseDuckDuckGo(html, count);
    if (!out.length) return '搜索「' + query + '」无结果';
    let text = '搜索「' + query + '」结果：\n';
    out.forEach((r, i) => { text += (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snip ? '\n   摘要：' + r.snip : '') + '\n'; });
    return text.slice(0, 4000);
  } catch (e) {
    return '搜索失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally { clearTimeout(timer); }
}

// ==================== SSRF 防护（v6.8.1） ====================
// web_fetch 的目标 URL 来自模型输出（可被用户 prompt 间接操控），必须拦截
// 内网 / 本机 / 云元数据地址，防止 Worker 被当成代理去探测内网或借出口 IP 攻击第三方。
// Workers 拿不到底层 DNS，做两层拦截：
//  1) 字面量私网 IP —— WHATWG URL 解析会自动把十进制/十六进制/八进制写法归一化为
//     点分十进制（如 http://2130706433/ → 127.0.0.1、http://0x7f.0.0.1/ → 127.0.0.1），
//     因此只需判断归一化后的 hostname；
//  2) 危险主机名（localhost、各类云元数据服务域名）。
// 残余风险：DNS 重绑定（域名先解析到公网、TTL 过期后指向内网）。Workers 无法在建连时
// 做二次校验，如需彻底封堵请在前置 WAF / 出站代理层限制。
function isBlockedFetchHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  // —— 危险主机名 ——
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  if (h === 'instance-data' || h === 'instance-data.compute.internal') return true;
  if (h === 'metadata.azure.internal' || h === 'metadata') return true;
  if (h === '169.254.169.254.nip.io' || h.endsWith('.169.254.169.254.nip.io')) return true;
  // —— IPv4 私网段 ——
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const b = [+v4[1], +v4[2], +v4[3], +v4[4]];
    if (b.some(n => n > 255)) return true; // 越界收尾，宁可拦截
    if (b[0] === 10) return true;                          // 10.0.0.0/8
    if (b[0] === 127) return true;                         // 127.0.0.0/8 回环
    if (b[0] === 169 && b[1] === 254) return true;          // 169.254.0.0/16（含云元数据）
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true; // 172.16.0.0/12
    if (b[0] === 192 && b[1] === 168) return true;          // 192.168.0.0/16
    if (b[0] === 0) return true;                           // 0.0.0.0/8
    if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return true; // 100.64.0.0/10
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return true;   // TEST-NET-1
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return true; // TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return true;  // TEST-NET-3
    return false;
  }
  // —— IPv6（hostname 可能带方括号） ——
  const h6 = h.replace(/^\[|\]$/g, '');
  if (h6.indexOf(':') !== -1) {
    // 内嵌点分十进制的 IPv4 映射地址，如 ::ffff:127.0.0.1 → 按 IPv4 再判一次
    const tail = h6.slice(h6.lastIndexOf(':') + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isBlockedFetchHost(tail);
    const flat = h6.replace(/:/g, '');
    if (flat === '1') return true;            // ::1 回环
    if (/^fe[89ab]/.test(flat)) return true;  // fe80::/10 链路本地
    if (/^(fc|fd)/.test(flat)) return true;   // fc00::/7 唯一本地
    if (flat.startsWith('ffff') && flat.length >= 12) { // ::ffff:a.b.c.d 纯十六进制形式
      const hex = flat.slice(-8);
      const b = [];
      for (let k = 0; k < 8; k += 2) b.push(parseInt(hex.slice(k, k + 2), 16));
      return isBlockedFetchHost(b.join('.'));
    }
    return false;
  }
  return false;
}

async function toolWebFetch(url) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return 'URL 非法，仅支持 http/https';
  // v6.8.1 SSRF 防护：先解析 hostname 再放行
  let fetchHost = '';
  try { fetchHost = new URL(url).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
  if (isBlockedFetchHost(fetchHost)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: ctrl.signal, redirect: 'follow'
    });
    if (!res.ok) return '抓取失败，HTTP ' + res.status;
    const ct = res.headers.get('content-type') || '';
    if (/pdf|image|video|audio|octet-stream/i.test(ct)) return '不支持抓取该类型内容(' + ct + ')';
    let html = await res.text();
    if (html.length > 500000) html = html.slice(0, 500000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    if (!text) return '页面无有效文本内容';
    return text.slice(0, 6000);
  } catch (e) {
    return '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally { clearTimeout(timer); }
}

// 安全计算器：递归下降解析，绝不使用 eval
function toolCalculate(expr) {
  try {
    const s = String(expr || '').replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
    if (!s) return '表达式为空';
    if (/[^0-9+\-*/%^().]/.test(s)) return '表达式含非法字符';
    let i = 0;
    function parseExpr() {
      let v = parseTerm();
      while (i < s.length && (s[i] === '+' || s[i] === '-')) {
        const op = s[i++]; const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function parseTerm() {
      let v = parseFactor();
      while (i < s.length && (s[i] === '*' || s[i] === '/' || s[i] === '%')) {
        const op = s[i++]; const r = parseFactor();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    }
    function parseFactor() {
      // 一元正负号优先级低于乘方：-3^2 = -(3^2) = -9
      if (s[i] === '-') { i++; return -parseFactor(); }
      if (s[i] === '+') { i++; return parseFactor(); }
      let v = parsePrimary();
      if (i < s.length && s[i] === '^') { i++; v = Math.pow(v, parseFactor()); }
      return v;
    }
    function parsePrimary() {
      if (s[i] === '(') { i++; const v = parseExpr(); if (s[i] !== ')') throw new Error('括号不匹配'); i++; return v; }
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j === i) throw new Error('意外的字符: ' + s[i]);
      // v6.8.1：校验数字格式，防止 "5..3" 被 parseFloat 静默截断成 5
      const numStr = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(numStr)) throw new Error('数字格式非法: ' + numStr);
      const n = parseFloat(numStr); i = j;
      if (!isFinite(n)) throw new Error('数字非法');
      return n;
    }
    const v = parseExpr();
    if (i !== s.length) throw new Error('表达式未完全解析');
    if (!isFinite(v)) return '计算结果非法（可能除零）';
    return '计算结果：' + String(Math.round(v * 1e10) / 1e10);
  } catch (e) { return '计算失败: ' + e.message; }
}

function toolGetTime(timezone) {
  const tz = String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'long'
    });
    return '当前时间（' + tz + '）：' + fmt.format(new Date());
  } catch (e) { return '时区无效: ' + tz; }
}

async function toolGetWeather(city) {
  city = String(city || '').trim();
  if (!city) return '城市名为空';
  try {
    const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json')).json();
    if (!g.results || !g.results.length) return '找不到城市：' + city;
    const loc = g.results[0];
    const w = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=2')).json();
    const wm = { 0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷阵雨' };
    const c = w.current, d = w.daily;
    let t = loc.name + '（' + (loc.country || '') + '）当前：' + (wm[c.weather_code] || '未知') +
      '，' + c.temperature_2m + '°C，体感' + c.apparent_temperature + '°C，湿度' + c.relative_humidity_2m + '%，风速' + c.wind_speed_10m + 'km/h\n';
    t += '今明两天：' + d.time.map((dt, i) => dt.slice(5) + ' ' + (wm[d.weather_code[i]] || '') + ' ' + d.temperature_2m_min[i] + '~' + d.temperature_2m_max[i] + '°C').join('；');
    return t;
  } catch (e) { return '天气查询失败: ' + e.message; }
}

// ==================== Telegram Agent：长期记忆 + 开关 ====================
const tgAgentMemCache = new Map();
const tgAgentModeCache = new Map();

async function agentGetMemories(env, chatId) {
  if (tgAgentMemCache.has(chatId)) return tgAgentMemCache.get(chatId);
  let arr = [];
  // v6.6.6 起知识库搬入 kb/ 文件夹：先读新 key；若为空再尝试旧 key，
  // 读到旧数据立即搬迁（写新 key + 删旧 key），老部署升级不丢记忆。
  let raw = await storeGet(env, agentMemKey(chatId));
  if (!raw) {
    const legacy = await storeGet(env, agentMemKeyLegacy(chatId));
    if (legacy) {
      raw = legacy;
      // v6.8.4：先确认新 key 写成功再删旧 key——之前静默写入失败后仍删旧 key 会丢数据
      const okMig = await storePutChecked(env, agentMemKey(chatId), legacy);
      if (okMig) await storeDelete(env, agentMemKeyLegacy(chatId));
    }
  }
  if (raw) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (e) {}
  }
  // v6.6.7：回补 md 镜像 —— 老条目自动分配文件名并建 md；控制台误删的 md 也会按索引重建
  try {
    if (await kbBackfillMd(env, chatId, arr)) {
      // v6.8.4：回补索引写入改用 checked；失败不影响本次内存读取，下次加载/保存会重试
      await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
    }
  } catch (e) {}
  mapSetBounded(tgAgentMemCache, chatId, arr);
  return arr;
}

async function agentSaveMemory(env, chatId, fact) {
  const arr = await agentGetMemories(env, chatId);
  fact = String(fact || '').trim().slice(0, 200);
  if (!fact) return '内容为空，未保存';
  if (arr.some(m => m.fact === fact)) return '已记住过，无需重复保存';
  // v6.6.7：条目带 file 字段；先写 md 镜像再写索引（索引是唯一可信源）
  const m = { fact: fact, ts: Date.now(), file: kbNewMemFile() };
  arr.push(m);
  // v6.4.1 起彻底不限条数：R2 单对象可达 5TB，且每次 prompt 只按预算注入，
  // 条数增长不影响 token 成本；remember 需用户明确要求才会触发，无失控风险。
  mapSetBounded(tgAgentMemCache, chatId, arr);
  // v6.8.3：未绑定 R2 时只留内存，必须如实告知——之前会谎称"已记住"，重启就丢
  if (!env.R2) {
    return '已暂存于内存（R2 未绑定，Worker 重启后会丢失；按 README 第二步绑定 R2 后可永久记住）：' + fact;
  }
  const okMd = await storePutChecked(env, kbMemDir(chatId) + m.file, kbMemMarkdown(chatId, fact, m.ts));
  const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
  if (!okMd || !okIdx) return '记忆写入 R2 失败，已暂存于内存；请检查 R2 绑定与权限后重试：' + fact;
  return '已记住：' + fact + '（共' + arr.length + '条）';
}

async function agentForgetMemory(env, chatId, keyword) {
  keyword = String(keyword || '').trim();
  if (!keyword) return { removed: 0 };
  const arr = await agentGetMemories(env, chatId);
  const kept = arr.filter(m => String(m.fact || '').indexOf(keyword) < 0);
  const removed = arr.length - kept.length;
  if (removed > 0) {
    // v6.6.7：同步删除被删条目的 md 镜像
    const keptSet = new Set(kept);
    const files = [];
    for (const m of arr) {
      if (!keptSet.has(m) && m && m.file) files.push(kbMemDir(chatId) + m.file);
    }
    // v6.8.4：索引写入失败时不更新缓存并如实报错，否则"删了但重启又复活"
    if (!env.R2) {
      mapSetBounded(tgAgentMemCache, chatId, kept);
      if (files.length) await kbDeleteKeys(env, files);
      return { removed: removed };
    }
    const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(kept));
    if (!okIdx) {
      return { removed: 0, persistError: '记忆索引写入 R2 失败，未删除任何记忆；请检查 R2 绑定与权限后重试' };
    }
    mapSetBounded(tgAgentMemCache, chatId, kept);
    if (files.length) await kbDeleteKeys(env, files);
  }
  return { removed: removed };
}

// ==================== 知识库文档（v6.8.0 重构）：注册表方案 ====================
// kb/docs/registry.json 是文档的唯一注册表：[{file, title, source, size, updated_at}]。
// save / list / read / delete 全部走注册表：去重与列表都是 O(1)，不再逐篇扫描 frontmatter。
// 注册表缺失或损坏时自动扫描 kb/docs/ 重建（自愈）；registry.json 本身永不计入文档。
// 文件名仍为 kb/docs/<标题>.md（标题清洗，中文保留）。
// 注意：注册表更新是 read-modify-write，极端并发下可能丢失一次更新；个人单用户场景可接受。
const KB_DOCS_PREFIX = KB_PREFIX + 'docs/';
const KB_REGISTRY_KEY = KB_DOCS_PREFIX + 'registry.json';

// 文件名由标题清洗得到（去掉 / \ : * ? " < > | # 与控制字符，中文保留；
// 空格直接去掉——避免"甲骨文云 ARM"与"甲骨文云ARM"生成两个文件），超长截断；
// 标题被洗空时用时间戳兜底。
function kbDocSlug(title) {
  let s = String(title || '').trim()
    .replace(/[\/\\:*?"<>|#\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 80);
  if (!s) s = 'doc_' + Date.now().toString(36);
  return s;
}
// 原文链接归一化：去首尾空格、去末尾斜杠、转小写
function kbNormSource(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }
function kbDocTitleOf(key) {
  let t = String(key || '').slice(KB_DOCS_PREFIX.length);
  if (t.endsWith('.md')) t = t.slice(0, -3);
  return t;
}
// 解析 save_doc 生成的 frontmatter 头（---\nkey: value\n---）
function kbParseFrontmatter(head) {
  const out = {};
  const m = String(head || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}
// 列出 kb/docs/ 下全部文档对象（分页取全量；自动排除 registry.json）
async function kbListDocObjects(env) {
  const objs = [];
  if (!env.R2) return objs;
  try {
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: KB_DOCS_PREFIX, limit: 1000, cursor: cursor });
      for (const o of (listed.objects || [])) {
        if (o.key !== KB_REGISTRY_KEY) objs.push(o);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {}
  return objs;
}
// 从现有文件重建注册表（读每篇前 1200 字节的 frontmatter），并写回
async function kbRebuildRegistry(env) {
  const reg = [];
  if (!env.R2) return reg;
  const objs = await kbListDocObjects(env);
  for (const o of objs) {
    let fm = {};
    try {
      // v6.8.4：frontmatter 含长标题/长 source 时 1200 字节可能截断，放大到 4096
      const r = await env.R2.get(o.key, { range: { offset: 0, length: 4096 } });
      if (r) fm = kbParseFrontmatter(await r.text());
    } catch (e) {}
    reg.push({
      file: String(o.key).slice(KB_DOCS_PREFIX.length),
      title: fm.title || kbDocTitleOf(o.key),
      source: fm.source || '',
      size: o.size || 0,
      updated_at: fm.saved_at || (o.uploaded ? new Date(o.uploaded).toISOString() : '')
    });
  }
  await kbSaveRegistry(env, reg);
  return reg;
}
async function kbGetRegistry(env) {
  if (!env.R2) return [];
  try {
    const obj = await env.R2.get(KB_REGISTRY_KEY);
    if (obj) {
      const p = JSON.parse(await obj.text());
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  // 缺失或损坏 → 自动重建（自愈）
  return await kbRebuildRegistry(env);
}
// v6.8.4：返回布尔值——注册表写入失败必须让调用方知道，
// 否则会出现"文档已保存但列表/读取找不到"的幽灵成功。
async function kbSaveRegistry(env, reg) {
  if (!env.R2) return false;
  try { await env.R2.put(KB_REGISTRY_KEY, JSON.stringify(reg)); return true; }
  catch (e) { return false; }
}
// 注册表内模糊查找：标题精确相等 > 标题包含 > 文件名包含（大小写不敏感）
function kbFindRegEntry(reg, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !reg || !reg.length) return null;
  // v6.8.4：查询也做 slug 归一化（去空格/特殊字符），"甲骨文云 ARM" 能命中 "甲骨文云ARM"
  let qSlug = '';
  try { qSlug = kbDocSlug(query).toLowerCase(); } catch (e) {}
  return reg.find(e => String(e.title || '').toLowerCase() === q)
    || reg.find(e => String(e.title || '').toLowerCase().indexOf(q) !== -1)
    || (qSlug && reg.find(e => { try { return kbDocSlug(e.title || e.file).toLowerCase().indexOf(qSlug) !== -1; } catch (ee) { return false; } }))
    || reg.find(e => String(e.file || '').toLowerCase().indexOf(q) !== -1)
    || null;
}
function kbFmtSize(b) {
  b = b || 0;
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}
function kbFmtDate(d) {
  try { const s = new Date(d).toISOString().slice(0, 10); return s === '1970-01-01' ? '' : s; } catch (e) { return ''; }
}
async function toolSaveDoc(env, chatId, args) {
  args = args || {};
  // v6.8.4：标题/source 去掉换行（换行会破坏 frontmatter 解析，导致重建注册表时标题丢失）
  const title = String(args.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  const cleanSource = String(args.source || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  let content = String(args.content || '');
  if (!title) return '标题为空，未保存';
  if (!content.trim()) return '内容为空，未保存';
  // v6.8.3：R2 未绑定时必须明确失败——之前会静默跳过写入却谎称"已保存"
  if (!env.R2) return 'R2 未绑定，知识库文档无法保存。请先按 README 第二步绑定 R2 存储桶后再试；本次内容未保存。';
  if (content.length > 100000) content = content.slice(0, 100000) + '\n\n> （内容过长，仅保存前 10 万字符）';
  const file = kbDocSlug(title) + '.md';
  const key = KB_DOCS_PREFIX + file;
  const reg = await kbGetRegistry(env);
  // 同链接去重（O(1) 查注册表）：已存为另一篇文档时拒绝
  const normSrc = kbNormSource(args.source);
  if (normSrc) {
    const dup = reg.find(e => kbNormSource(e.source) === normSrc);
    if (dup && dup.file !== file) {
      return '该链接已保存为知识库文档《' + (dup.title || dup.file) + '》，未重复保存。如需更新内容，请用标题"' + (dup.title || dup.file) + '"（或清洗后同名标题）重新保存以覆盖，或先用 delete_doc 删除旧文档。';
    }
  }
  const prevEntry = reg.find(e => e.file === file);
  const existed = !!prevEntry;
  const head = '---\ntitle: "' + title.replace(/"/g, '') + '"\nsaved_at: ' + new Date().toISOString()
    + '\nchat_id: "' + kbSafeChatId(chatId) + '"'
    + (cleanSource ? '\nsource: ' + cleanSource : '')
    + '\n---\n\n';
  const body = head + content;
  // v6.8.3：校验写入结果，R2 写入失败（如权限问题）不再谎称成功
  const okDoc = await storePutChecked(env, key, body);
  if (!okDoc) return '知识库文档写入 R2 失败（' + key + '），请检查 R2 绑定与权限后重试；本次内容未保存。';
  const entry = {
    file: file,
    title: title,
    source: cleanSource,
    size: body.length,
    updated_at: new Date().toISOString()
  };
  const idx = reg.findIndex(e => e.file === file);
  if (idx >= 0) reg[idx] = entry; else reg.push(entry);
  // v6.8.4：注册表写入失败必须如实返回——正文已落盘但列表查不到时，引导用户重试修复
  const okReg = await kbSaveRegistry(env, reg);
  if (!okReg) return '文档正文已写入 R2（' + key + '），但注册表更新失败，文档可能暂不出现在列表中；请稍后重新保存一次以修复注册表，本次内容未丢失。';
  let verNote = existed ? '，已覆盖旧版本' : '，新建';
  // v6.8.4：slug 碰撞提示——"A/B" 与 "AB" 会生成同一文件，覆盖时明确告知
  if (existed && prevEntry && prevEntry.title !== title) {
    verNote += '（注意：新标题清洗后与旧文档《' + prevEntry.title + '》同名，旧内容已被覆盖）';
  }
  return '已保存为知识库文档：' + key + '（' + content.length + ' 字符' + verNote + '）';
}
async function toolListDocs(env) {
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档，可用 save_doc 保存）';
  return '知识库文档（共' + reg.length + '篇）：\n' +
    reg.map((e, i) => (i + 1) + '. ' + (e.title || e.file) + '（' + kbFmtSize(e.size) + '，' + kbFmtDate(e.updated_at) + '）').join('\n');
}
async function toolReadDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要读取的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档）';
  const hit = kbFindRegEntry(reg, query);
  if (hit) {
    try {
      const obj = await env.R2.get(KB_DOCS_PREFIX + hit.file);
      if (!obj) return '文档读取失败：' + (hit.title || hit.file);
      let text = await obj.text();
      const MAX = 8000;
      let note = '';
      if (text.length > MAX) { text = text.slice(0, MAX); note = '\n\n> （文档过长，仅显示前 8000 字符）'; }
      return '【知识库文档《' + (hit.title || hit.file) + '》】\n' + text + note;
    } catch (e) { return '文档读取失败：' + (hit.title || hit.file); }
  }
  // 标题无命中 → 全文关键词检索（最多查 30 篇）
  const snippet = await kbSearchDocBody(env, reg.slice(0, 30).map(e => KB_DOCS_PREFIX + e.file), query);
  if (snippet) return snippet;
  return '未找到标题或正文包含"' + query + '"的文档。现有文档：\n' +
    reg.map(e => '- ' + (e.title || e.file)).join('\n');
}
// 全文关键词检索：分批并发读正文，返回首个命中的关键词上下文片段
// v6.8.4：原逐篇串行在文档多/正文大时易超时（工具超时 30s），改为每批 5 篇并发
async function kbSearchDocBody(env, keys, query) {
  const q = query.toLowerCase();
  const BATCH = 5;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (k) => {
      try {
        const obj = await env.R2.get(k);
        if (!obj) return null;
        const text = await obj.text();
        const idx = text.toLowerCase().indexOf(q);
        if (idx === -1) return null;
        return { k: k, text: text, idx: idx };
      } catch (e) { return null; }
    }));
    const hit = results.find(r => r);
    if (hit) {
      const start = Math.max(0, hit.idx - 600), end = Math.min(hit.text.length, hit.idx + query.length + 600);
      let frag = hit.text.slice(start, end);
      if (start > 0) frag = '…' + frag;
      if (end < hit.text.length) frag = frag + '…';
      return '【知识库文档《' + kbDocTitleOf(hit.k) + '》· 正文关键词命中】\n' + frag +
        '\n\n> （仅显示关键词附近片段；用 read_doc 以完整标题「' + kbDocTitleOf(hit.k) + '」可读全文）';
    }
  }
  return null;
}
async function toolDeleteDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要删除的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法删除知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空，无需删除';
  const hit = kbFindRegEntry(reg, query);
  if (!hit) {
    return '未找到标题包含"' + query + '"的文档。现有文档：\n' +
      reg.map(e => '- ' + (e.title || e.file)).join('\n');
  }
  try { await env.R2.delete(KB_DOCS_PREFIX + hit.file); } catch (e) { return '删除失败：' + (hit.title || hit.file); }
  // v6.8.4：注册表更新失败要如实告知，否则列表里会有"幽灵条目"导致读取失败
  const okReg = await kbSaveRegistry(env, reg.filter(e => e !== hit));
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  return '已删除知识库文档《' + (hit.title || hit.file) + '》';
}

// 获取 Agent 模式开关（默认开启）
async function agentGetMode(env, chatId) {
  if (tgAgentModeCache.has(chatId)) return tgAgentModeCache.get(chatId);
  let on = true; // 默认开启 Agent 模式
  const v = await storeGet(env, 'agent_mode_' + chatId);
  on = v !== '0';
  mapSetBounded(tgAgentModeCache, chatId, on);
  return on;
}

async function agentSetMode(env, chatId, on) {
  mapSetBounded(tgAgentModeCache, chatId, on);
  await storePut(env, 'agent_mode_' + chatId, on ? '1' : '0');
}

// 记忆分词：英文按词、中文按 2-gram，用于相关性打分
function memoryTokens(s) {
  const out = [];
  const segs = String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

// 构建 Agent 系统提示词（记忆按【相关性 + 新近度】排序注入，而非只取最新）
function buildAgentSystemPrompt(memories, query) {
  const now = new Date();
  let timeStr = '';
  try {
    timeStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' }).format(now);
  } catch (e) { timeStr = now.toISOString(); }
  let p = '你是 Cloudflare-Chat 智能助手，一个具备自主规划、工具调用和长期记忆能力的 AI Agent。\n';
  p += '当前时间：' + timeStr + '（北京时间）。\n\n';
  p += '【工作方式】\n'
    + '1. 意图判断：闲聊、简单问答、你知识范围内的稳定知识——直接回答，绝不调用工具。工具是稀缺资源，能不用就不用。\n'
    + '2. 工具选择：需要最新/实时信息（新闻、价格、赛事等）→ web_search，可换多个关键词搜索；想深入了解某条结果 → web_fetch 读原文；任何精确计算 → calculate（不要心算）；天气 → get_weather；时间 → get_time；用户明确告知的长期事实（偏好、生日、项目、城市等）→ remember；用户明确要求把长内容存成文档 → save_doc（同名覆盖即更新；同一网址只保存一次，勿换标题重复保存）；用户明确要求删除文档 → delete_doc；用户问题可能涉及知识库文档主题 → 先 list_docs 看标题，有相关再 read_doc 细读（标题想不起来时 read_doc 会自动搜正文），文档内容优先引用并注明"据知识库文档《xxx》"。\n'
    + '3. 多步规划：允许先搜索再抓取、先计算再汇总，一次可并行调用多个工具；但每次只规划接下来 1-2 步，拿到结果再决定下一步，不要一次规划过长链条。\n'
    + '4. 诚实：工具没给的信息绝不编造；搜索无结果就直说。\n'
    + '5. 语言：默认用中文回答（用户用其他语言时跟随用户语言）。\n'
    + '6. 含糊处理：问题缺少关键信息且工具无法补足时（如查天气没说城市），用一句话追问，不要猜测调用工具。\n'
    + '7. 技术细节隔离：最终回答里绝不出现函数名、参数 JSON、调用标记等技术细节，只呈现结论本身。\n\n';
  p += '【输出要求】\n'
    + '- 重要结论先行，结构清晰，适合手机阅读；代码用代码块。\n'
    + '- 引用网络信息给出结论即可，不必罗列链接（除非用户要求）；数据注明来源与时间（如"据今日搜索"），不确定的信息明确标注。\n\n';
  if (memories.length) {
    const qTokens = memoryTokens(query);
    const scored = memories.map((m) => {
      const fSet = new Set(memoryTokens(m.fact)); // Set 查找 O(1)，记忆量大也不慢
      let score = 0;
      for (const t of qTokens) if (fSet.has(t)) score += t.length >= 2 ? 2 : 1;
      return { m, score };
    });
    scored.sort((a, b) => (b.score - a.score) || ((b.m.ts || 0) - (a.m.ts || 0)));
    let budget = 6000;
    const picked = [];
    for (const s of scored) {
      const f = String(s.m.fact || '');
      if (!f || f.length > budget) continue;
      picked.push(f);
      budget -= f.length;
    }
    p += '【关于用户的长期记忆】（共' + memories.length + '条' +
      (picked.length < memories.length ? '，按与本次提问的相关性注入' + picked.length + '条' : '') + '）\n' +
      picked.map(f => '- ' + f).join('\n') + '\n\n';
  }
  p += '【重要规则】\n'
    + '- 需要用户私密或实时信息时必须用工具核实，不要凭空猜测。\n'
    + '- remember 只用于用户明确要求记住的长期事实，不要把临时对话内容存进去。\n'
    + '- save_doc 是唯一能写知识库文档的途径：只有它返回成功，才可以告诉用户"已保存/已生成文档"；没有调用成功就不许声称。长文档用 save_doc，不要用 remember 硬塞。\n'
    + '- 知识库优先：read_doc 读到的文档内容优先于通用知识和训练记忆引用，引用时注明"据知识库文档《标题》"。\n'
    + '- 同一工具用相同参数反复调用没有意义：换关键词/换思路，仍无进展就基于已有信息直接回答。\n'
    + '- 当你觉得已经掌握足够信息，直接给出最终答案，不要为了调用工具而调用工具。';
  return p;
}

// ==================== DSML 工具调用兼容（v6.6.4） ====================
// 背景：DeepSeek V3.2 / V4 系模型的服务层（vLLM / SGLang 等）在收到带 tools 的请求时，
// 会往 system prompt 注入一段 "## Tools" 说明，要求模型用
//   <｜DSML｜tool_calls><｜DSML｜invoke name="get_weather">
//   <｜DSML｜parameter name="city" string="true">上海</｜DSML｜parameter>
//   </｜DSML｜invoke></｜DSML｜tool_calls>
// 这种 XML 式标记输出工具调用，并由网关负责把它解析回 OpenAI 标准的 tool_calls 字段。
// 若通道是裸透传（不做这层转换），响应的 message.tool_calls 为空、DSML 原文留在
// message.content 里——Agent 循环会把它当成最终答案直接发给用户（markup 泄漏），
// 且工具一次都不会执行。本节做客户端兼容：
//   1) parseDSMLToolCalls：从 content 解析 DSML → 转成标准 tool_calls 参与执行；
//   2) stripDSMLBlocks：兜底剥离，任何返回给用户的文本都不允许携带 DSML markup。
// 兼容性：外层标签 tool_calls / function_calls / calls 三种变体；全角｜/半角|、
// 标签内多余空格、未闭合（被截断）的块都能容忍；单个 malformed 的 invoke 被跳过，
// 不影响同块内其它调用。

// 从文本中提取 DSML 工具调用，转成 OpenAI 标准 tool_calls 数组；找不到返回 []。
function parseDSMLToolCalls(content) {
  const text = String(content || '');
  if (text.indexOf('DSML') === -1) return [];
  const calls = [];
  let seq = 0;
  // 外层块（未闭合则截到文末，避免截断输出导致整个解析失败）
  const blockRe = /<\s*[|｜]\s*DSML\s*[|｜]\s*(tool_calls|function_calls|calls)\s*>([\s\S]*?)(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*\1\s*>|$)/g;
  let bm;
  while ((bm = blockRe.exec(text))) {
    const body = bm[2];
    const invRe = /<\s*[|｜]\s*DSML\s*[|｜]\s*invoke\b([^>]*)>([\s\S]*?)(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*invoke\s*>|$)/g;
    let im;
    while ((im = invRe.exec(body))) {
      const nameM = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(im[1] || '');
      const name = nameM ? (nameM[1] !== undefined ? nameM[1] : nameM[2]) : '';
      if (!name) continue;
      const args = {};
      const pRe = /<\s*[|｜]\s*DSML\s*[|｜]\s*parameter\b([^>]*)>([\s\S]*?)<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*parameter\s*>/g;
      let pm;
      while ((pm = pRe.exec(im[2]))) {
        const pnM = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(pm[1] || '');
        const pName = pnM ? (pnM[1] !== undefined ? pnM[1] : pnM[2]) : '';
        if (!pName) continue;
        const sM = /\bstring\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(pm[1] || '');
        const isStr = sM ? (sM[1] !== undefined ? sM[1] : sM[2]) !== 'false' : true;
        const raw = pm[2];
        if (isStr) {
          args[pName] = raw.trim();
        } else {
          try { args[pName] = JSON.parse(raw); }
          catch (e) { args[pName] = raw.trim(); }
        }
      }
      seq += 1;
      calls.push({
        id: 'call_dsml_' + Date.now().toString(36) + '_' + seq,
        type: 'function',
        function: { name: name, arguments: JSON.stringify(args) }
      });
    }
  }
  return calls;
}

// 兜底剥离：删掉文本里残留的 DSML 块（含未闭合的）、零散 DSML 标签，
// 以及 DeepSeek 偶发泄漏的 <｜end▁of▁sentence｜> 结束符。幂等，无 DSML 时原文返回。
function stripDSMLBlocks(content) {
  let text = String(content || '');
  if (text.indexOf('DSML') === -1 && text.indexOf('end▁of▁sentence') === -1) return text;
  // 成对或未闭合的外层块（三种外层标签名，闭合标签名不一致也照删）
  text = text.replace(/<\s*[|｜]\s*DSML\s*[|｜]\s*(?:tool_calls|function_calls|calls)\s*>[\s\S]*?(?:<\s*\/\s*[|｜]\s*DSML\s*[|｜]\s*(?:tool_calls|function_calls|calls)\s*>|$)/g, '');
  // 残留的零散 DSML 标签（含属性的也删）
  text = text.replace(/<\s*\/?\s*[|｜]\s*DSML\s*[|｜]\s*[^<>]*>/gi, '');
  // DeepSeek 结束符
  text = text.replace(/<\s*[|｜]\s*end▁of▁sentence\s*[|｜]\s*>/g, '');
  return text;
}

// ==================== Agent 稳定性增强（v6.6.5） ====================
// 1) truncateToolResult：工具结果截断并明确标注，避免模型误以为拿到了完整数据。
// 2) toolCallSignature：工具调用签名，用于"重复调用熔断"。
// 3) trimAgentMessages：上下文预算裁剪。多步任务中工具结果（每条可达 4000 字）
//    会快速堆积，超预算时从最旧的"整轮"（1 条 assistant + 其 tool 消息）开始删，
//    成对删除保证 OpenAI 消息序列合法性（assistant tool_calls 后必须紧跟 tool 应答）。
//    只动本轮循环产生的消息（loopStartIdx 之后），system 与历史对话永不裁剪。

// 工具结果截断：超长时保留前 maxChars 并标注，避免模型误判为完整数据
function truncateToolResult(result, maxChars) {
  const s = String(result == null ? '' : result);
  maxChars = maxChars > 0 ? maxChars : 4000;
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n…（结果过长，仅显示前 ' + maxChars + ' 字符）';
}

// 工具调用签名：name + 规范化后的参数，用于检测模型是否在原地打转
function toolCallSignature(tc) {
  const fn = (tc && tc.function) || {};
  let args = {};
  try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }
  const keys = Object.keys(args).sort();
  const norm = {};
  for (const k of keys) norm[k] = args[k];
  return (fn.name || '') + '|' + JSON.stringify(norm);
}

// 按字符预算裁剪 Agent 循环消息；返回新数组（不修改原数组，便于测试与断点续存）
function trimAgentMessages(messages, loopStartIdx, budget) {
  budget = budget > 0 ? budget : 24000;
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.length <= 1) return arr.slice();
  let start = Math.max(0, Math.min(loopStartIdx | 0, arr.length));
  // 估算字符数（JSON 长度近似 token 量的上界）
  const msgLen = (m) => {
    try { return JSON.stringify(m).length; } catch (e) { return 0; }
  };
  let total = 0;
  for (const m of arr) total += msgLen(m);
  if (total <= budget) return arr.slice();
  // 找出本轮循环内的"轮次"边界：每轮以 role=assistant 开头
  const rounds = [];
  let cur = -1;
  for (let i = start; i < arr.length; i++) {
    if (arr[i] && arr[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
  // 至少保留最后一轮（当前正在进行的上下文），从最旧的轮次开始删
  const doomed = new Set();
  for (let r = 0; r < rounds.length - 1 && total > budget; r++) {
    for (const i of rounds[r]) { doomed.add(i); total -= msgLen(arr[i]); }
  }
  if (!doomed.size) return arr.slice();
  const out = [];
  for (let i = 0; i < arr.length; i++) if (!doomed.has(i)) out.push(arr[i]);
  return out;
}

// ==================== Telegram Agent：主循环 ====================
// ReAct 风格：LLM 决策 → 执行工具 → 结果回填 → 最多 MAX_STEPS 步。
// 通道/模型不支持 tools 参数时返回 { fallback: true }，由调用方降级为普通对话。
// Agent 运行限制（可配，防极端情况失控）
function agentLimits(env) {
  let maxSteps = parseInt(env.AGENT_MAX_STEPS || '6', 10);
  if (!(maxSteps > 0)) maxSteps = 6;
  if (maxSteps > 12) maxSteps = 12;
  let timeoutMs = parseInt(env.AGENT_TIMEOUT_MS || '240000', 10);
  if (!(timeoutMs > 0)) timeoutMs = 240000;
  return { maxSteps, timeoutMs };
}

// 工具调用的人类可读描述，用于进度提示
function describeToolCall(name, args) {
  args = args || {};
  switch (name) {
    case 'web_search': return '🔍 正在搜索：' + (args.query || '');
    case 'web_fetch': return '📄 正在读取网页…';
    case 'calculate': return '🧮 正在计算：' + (args.expression || '');
    case 'get_weather': return '🌤 正在查询天气：' + (args.city || '');
    case 'get_time': return '🕐 正在获取时间…';
    case 'remember': return '🧠 正在记住…';
    case 'save_doc': return '💾 正在保存文档：' + (args.title || '');
    case 'list_docs': return '📚 正在查看知识库文档…';
    case 'read_doc': return '📖 正在读取文档：' + (args.query || '');
    case 'delete_doc': return '🗑️ 正在删除文档：' + (args.query || '');
    default: return '⚙️ 正在调用：' + name;
  }
}

// ==================== Agent 断点续做 ====================
// webhook 内单轮预算约 55 秒（Telegram 约 60 秒无响应会重发 update；
// 客户端断开后 worker 会被 cancel，靠"不断开赌长连接"是不可靠的）。
// 预算耗尽不再终结任务，而是把 ReAct 循环的 messages 存到 R2，
// 用户发「继续」即用全新预算接着跑，超长任务可分多段完成。
function tgAgentResumeKey(chatId) { return 'tg_agent_' + chatId; }
async function agentSaveResumeState(env, chatId, state) {
  if (!env.R2) return false;
  try {
    await storePut(env, tgAgentResumeKey(chatId), JSON.stringify(state));
    return true;
  } catch (e) { return false; }
}
async function agentLoadResumeState(env, chatId) {
  const raw = await storeGet(env, tgAgentResumeKey(chatId));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.messages) || !s.messages.length) return null;
    // 30 分钟过期：太旧的任务上下文已无意义
    if (Date.now() - (s.savedAt || 0) > 30 * 60 * 1000) {
      await agentClearResumeState(env, chatId);
      return null;
    }
    return s;
  } catch (e) { return null; }
}
async function agentClearResumeState(env, chatId) {
  try { await storeDelete(env, tgAgentResumeKey(chatId)); } catch (e) {}
}

function tgAgentDeadline(env, opts) {
  let timeoutMs = agentLimits(env).timeoutMs;
  // webhook 场景传入 maxRuntimeMs：HTTP 响应必须在 Telegram 因超时重发 update
  // 之前返回（约 60 秒），取两者较小值，避免整体预算形同虚设
  if (opts && opts.maxRuntimeMs > 0 && opts.maxRuntimeMs < timeoutMs) timeoutMs = opts.maxRuntimeMs;
  return Date.now() + timeoutMs;
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  const query = history.length ? String(history[history.length - 1].content || '') : '';
  const memories = await agentGetMemories(env, chatId);
  const systemPrompt = buildAgentSystemPrompt(memories, query);
  const tools = allowTools ? getAgentTools() : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const deadline = tgAgentDeadline(env, opts);
  return await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false);
}

// 「继续」入口：messages 里已包含 system + 历史，直接接着跑
async function tgAgentResume(env, tgApi, chatId, saved, onProgress, opts) {
  const allowTools = !!saved.allowTools;
  const tools = allowTools ? getAgentTools() : null;
  const deadline = tgAgentDeadline(env, opts);
  // v6.8.1：把首次运行时的 loopStartIdx 带回来，裁剪才能触及之前各段的老轮次，
  // 否则多段「继续」会让上下文无限增长；老版本存档无此字段则回退为旧行为
  const baseLoopStartIdx = (typeof saved.loopStartIdx === 'number' && saved.loopStartIdx >= 0) ? saved.loopStartIdx : undefined;
  return await tgAgentRunLoop(env, tgApi, chatId, saved.targetModelId, saved.messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, true, baseLoopStartIdx);
}

async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx) {
  const maxSteps = agentLimits(env).maxSteps;
  const lastAssistantText = () => {
    const f = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    return f ? f.content : '';
  };
  // v6.8.2 作用域修复：loopStartIdx 与 ctxBudget 必须在函数作用域声明、
  // 且位于 pauseForResume 之前。之前误放在 try 块内，而 pauseForResume
  // 与步数用尽分支都在 try 块之外引用它们，导致 ReferenceError: loopStartIdx is not defined。
  // 本轮循环在 messages 中的起始下标：上下文裁剪只动这之后的消息，
  // system 与历史对话永不裁剪。「继续」时传入首次运行的下标，老轮次也可被裁剪，
  // 防止多段续做让上下文无限增长。
  const loopStartIdx = (typeof baseLoopStartIdx === 'number' && baseLoopStartIdx >= 0)
    ? Math.min(baseLoopStartIdx, messages.length)
    : messages.length;
  // 上下文预算（字符数，env AGENT_CONTEXT_BUDGET 可配，默认 24000）
  let ctxBudget = parseInt(env.AGENT_CONTEXT_BUDGET || '24000', 10);
  if (!(ctxBudget > 0)) ctxBudget = 24000;
  // 超时暂停：保存循环状态，用户发「继续」即恢复。无 R2 时退化为直接终结。
  // v6.8.1：保存前先按上下文预算裁剪本轮老轮次（trim 只删 loopStartIdx 之后的消息，
  // 该下标本身不受影响，可原样存档），否则多段「继续」会让存档与发送量无限增长。
  const pauseForResume = async () => {
    const t = stripDSMLBlocks(lastAssistantText());
    let saved = false;
    if (resumeKey) {
      saved = await agentSaveResumeState(env, chatId, {
        v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
        messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
        loopStartIdx: loopStartIdx
      });
    }
    if (saved) {
      return { text: '⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
    return { text: '（本次任务超时，已停止）' + (t ? '\n\n' + t : ''), usedTools: true };
  };

  // typing 心跳：长推理 / 长工具调用期间每 20 秒刷新一次"正在输入"，
  // 任何 return / throw 分支都会在 finally 里清理定时器
  const heartbeat = setInterval(() => {
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}
  }, 20000);
  try {
  // 重复调用熔断：记录每步工具调用签名，连续 3 步完全相同即判定模型原地打转
  const callSigHistory = [];
  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) return await pauseForResume();
    const stepLabel = '🤖 Agent 思考中' + (isResume ? '（继续）' : '') + '（第 ' + (step + 1) + ' 步）…';
    // 每步开始先报进度：LLM 长思考时用户也能看到活着
    if (typeof onProgress === 'function') {
      try { await onProgress(stepLabel); } catch (e) {}
    }
    // 长推理时保持 typing 状态不消失
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    // 超预算时裁剪本轮循环产生的旧 tool 轮次（成对删除，保证消息序列合法）
    const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget);
    const cfg = buildAIRequest(env, targetModelId, sendMessages, false, tools);
    if (cfg.error) return { error: cfg.error };

    let resp;
    try {
      // 单步超时取 3 分钟与整体剩余预算的较小值：避免整体 deadline 已过，
      // 还被一次上游调用拖住几分钟（webhook 必须在 Telegram 重发前返回）
      const remainMs = Math.max(0, deadline - Date.now());
      resp = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.currentApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.payload),
        signal: AbortSignal.timeout(Math.max(15000, Math.min(180000, remainMs)))
      });
    } catch (e) {
      // 中断分类：AbortSignal.timeout() 抛的是 TimeoutError（不是 AbortError），
      // 两种都可能是"上游 hung 住"或"我们自己的整体预算耗尽"。用 deadline 区分：
      // 预算耗尽 -> 暂停并保存进度（可「继续」）；否则 -> 上游超时提示。
      const nm = e && e.name ? String(e.name) : '';
      const msg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
      if (aborted && Date.now() >= deadline - 2000) return await pauseForResume();
      if (aborted) return { error: '上游响应超时，请重试或换个问法' };
      return { error: '网络错误：' + (msg || String(e)) };
    }

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      if (allowTools && /tool/i.test(t) && step === 0) return { fallback: true };
      return { error: 'API 报错 (' + resp.status + ')：' + String(t).slice(0, 500) };
    }

    const data = await resp.json().catch(() => null);
    // 图片生成通道：直接返回图片链接（不走工具循环）
    if (data && data.data && data.data[0] && data.data[0].url) {
      return { text: '[🖼️ 点击查看生成的图片](' + data.data[0].url + ')', usedTools: false, isImage: true };
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return { error: 'AI 没有返回有效内容' };

    // 原生 tool_calls 为空时，尝试从 content 解析 DSML 文本格式工具调用
    // （DeepSeek V3.2/V4 系模型 + 裸透传通道的组合会产生这种输出）
    let toolCalls = msg.tool_calls || [];
    let assistantText = msg.content || '';
    if (!toolCalls.length && assistantText.indexOf('DSML') !== -1) {
      const dsmlCalls = parseDSMLToolCalls(assistantText);
      if (dsmlCalls.length) {
        toolCalls = dsmlCalls;
        assistantText = stripDSMLBlocks(assistantText);
      }
    }
    const assistantMsg = { role: 'assistant', content: assistantText };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    // 推理模型（DeepSeek R1 等）多轮工具调用要求回传 reasoning_content，
    // 否则后续轮次会丢失推理上下文；不返回该字段的模型无影响
    const reasoning = msg.reasoning_content || msg.reasoning || '';
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    messages.push(assistantMsg);

    // 兜底：任何返回给用户的文本都不允许携带 DSML markup
    if (!toolCalls.length) {
      const clean = stripDSMLBlocks(assistantText).trim();
      let text = clean;
      if (!text) {
        text = assistantText.indexOf('DSML') !== -1
          ? '（工具调用格式解析失败，已隐藏原始标记，请换个问法重试或切换模型）'
          : (reasoning ? '（模型思考后没有给出文字答复，请换个问法重试）' : '（模型返回了空内容，请换个问法重试）');
      }
      return { text: text, usedTools: step > 0 };
    }

    // 重复调用熔断：连续 3 步工具调用完全相同 → 判定原地打转，直接收尾
    const stepSig = toolCalls.map(toolCallSignature).sort().join(';;');
    callSigHistory.push(stepSig);
    if (callSigHistory.length >= 3 &&
        callSigHistory[callSigHistory.length - 1] === stepSig &&
        callSigHistory[callSigHistory.length - 2] === stepSig &&
        callSigHistory[callSigHistory.length - 3] === stepSig) {
      const prefix = stripDSMLBlocks(assistantText).trim();
      return { text: (prefix ? prefix + '\n\n' : '') + '（检测到重复调用同一工具，已停止以避免空转；请换个问法或补充信息后重试）', usedTools: true };
    }

    // 进度提示：让用户看到 Agent 在干什么（force 突破节流）
    if (typeof onProgress === 'function') {
      try {
        const descs = toolCalls.map(tc => {
          const fn = (tc && tc.function) || {};
          let a = {};
          try { a = JSON.parse(fn.arguments || '{}'); } catch (e) {}
          return describeToolCall(fn.name || 'unknown', a);
        });
        await onProgress(stepLabel + '\n' + descs.join('\n'), true);
      } catch (e) {}
    }

    // 同一步的多个工具调用并行执行（顺序写回，保证消息顺序）
    const toolResults = await Promise.all(toolCalls.map(async (tc) => {
      const fn = (tc && tc.function) || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch (e) {}
      if (!fn.name) return { tc, result: '工具调用缺少名称，已跳过' };
      const result = await execAgentTool(fn.name, args, env, chatId);
      return { tc, result: truncateToolResult(result, 4000) };
    }));
    for (const tr of toolResults) {
      const fn = (tr.tc && tr.tc.function) || {};
      messages.push({
        role: 'tool',
        tool_call_id: tr.tc.id,
        name: fn.name || 'unknown',
        content: tr.result
      });
    }
  }
  } finally {
    clearInterval(heartbeat);
  }
  // 步数用尽：同样保存进度，允许「继续」（保存前先裁剪，见 pauseForResume 注释）
  const t = stripDSMLBlocks(lastAssistantText());
  if (resumeKey) {
    const saved = await agentSaveResumeState(env, chatId, {
      v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
      messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
      loopStartIdx: loopStartIdx
    });
    if (saved) {
      return { text: '⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
  }
  return { text: t || '（思考步数已用尽，请换个问法重试）', usedTools: true };
}

// ======= 统一解析通道配置（带内存缓存） =======
function getChannelConfig(env) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const models = [];
  const modelMap = new Map();

  const addModels = (modelStr, url, keys) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw) continue;
      
      // 用第一个冒号切分：模型 ID 本身不含冒号，显示名里允许出现冒号
      const colonIdx = raw.indexOf(':');
      const id = colonIdx > 0 ? raw.substring(0, colonIdx).trim() : raw;
      const name = colonIdx > 0 ? raw.substring(colonIdx + 1).trim() : raw;

      if (!modelMap.has(id)) {
        models.push({ id, name, original: raw });
        modelMap.set(id, { url, keys });
      }
    }
  };

  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
      });
      if (models.length > 0) {
        cachedConfig = { models, modelMap };
        return cachedConfig;
      }
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  let hasIndexed = false;
  for (let i = 1; i <= 20; i++) {
    const url = env[`API_URL_${i}`];
    const modelStr = env[`MODEL_${i}`];
    if (url && modelStr) {
      hasIndexed = true;
      const keys = parseCommaSeparated(env[`API_KEY_${i}`]);
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) {
    cachedConfig = { models, modelMap };
    return cachedConfig;
  }

  // 兜底：只使用环境变量中显式配置的模型，不再内置任何默认模型
  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = parseCommaSeparated(env.API_KEY);
  const fallbackModelStr = env.MODEL || "";

  if (fallbackUrl && fallbackModelStr) {
    addModels(fallbackModelStr, fallbackUrl, fallbackKeys);
  }

  cachedConfig = { models, modelMap };
  return cachedConfig;
}

// 提取共用的 AI 请求构建逻辑 (DRY原则)
// tools: 可选，OpenAI 兼容的 tools 数组（Agent 模式用）；图片通道自动忽略
function buildAIRequest(env, requestedModel, messagesArray, isStream, tools) {
  const { models, modelMap } = getChannelConfig(env);

  if (models.length === 0) {
    return { error: "未配置任何可用模型。请在 Worker 的环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1（或 API_URL / API_KEY / MODEL），保存后重新部署一次。" };
  }

  let selectedModel = requestedModel || models[0].id;

  if (!modelMap.has(selectedModel)) {
    selectedModel = models[0].id;
  }

  const channel = modelMap.get(selectedModel);
  if (!channel || !channel.url) return { error: `模型 ${selectedModel} 对应的 API_URL 未配置或异常` };

  const currentApiKey = channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
  const apiUrl = channel.url;
  // 图片模型只认 images/generations 接口地址，不再按模型名猜测，避免误伤
  const isImageAPI = apiUrl.includes('images/generations');

  // max_tokens 可配：环境变量 MAX_TOKENS，默认 4096，上限 32000
  let maxTokens = parseInt(env.MAX_TOKENS || '4096', 10);
  if (!(maxTokens > 0)) maxTokens = 4096;
  if (maxTokens > 32000) maxTokens = 32000;

  const payload = isImageAPI ? {
    model: selectedModel,
    prompt: messagesArray[messagesArray.length - 1].content,
    n: 1
  } : {
    model: selectedModel,
    messages: messagesArray,
    stream: isStream,
    max_tokens: maxTokens,
  };
  if (tools && tools.length && !isImageAPI) payload.tools = tools;

  return { apiUrl, currentApiKey, payload, isImageAPI };
}

// ==================== Web 端 Agent（v6.6.0） ====================
// 与 Telegram 共用 tgAgentChat（含 9 个零密钥工具 + 长期记忆），
// 记忆命名空间为 web_<sessionId>，与 Telegram 完全隔离。
// 进度通过 SSE 自定义事件推送：{"agent_progress": "..."} / {"agent_error": "..."}，
// 正文走标准 OpenAI delta 事件，最后 data: [DONE] 结束。
async function handleWebAgent(env, body) {
  const sid = String(body.session_id || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const webChatId = 'web_' + sid;
  const history = Array.isArray(body.messages) ? body.messages : [];
  const targetModelId = body.model;
  const encoder = new TextEncoder();
  // Web 无 Telegram 上下文：typing 心跳直接 no-op
  const noOpTgApi = () => Promise.resolve({ ok: true });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (e) {}
      };
      const done = () => {
        try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); } catch (e) {}
        try { controller.close(); } catch (e) {}
      };
      try {
        const onProgress = async (text) => { send({ agent_progress: String(text).slice(0, 500) }); };
        // opts 留空：Web 用完整 AGENT_TIMEOUT_MS 预算（浏览器长连接，无 60 秒重发问题），不做断点续做
        let r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, true, onProgress, {});
        if (r.fallback) r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, false, onProgress, {});
        if (r.error) {
          send({ agent_error: r.error });
        } else if (r.text) {
          const t = r.text;
          for (let i = 0; i < t.length; i += 2000) {
            send({ choices: [{ delta: { content: t.slice(i, i + 2000) } }] });
          }
        } else {
          send({ agent_error: 'AI 没有返回有效内容' });
        }
      } catch (e) {
        send({ agent_error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) });
      }
      done();
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 域名所有权验证文件（某第三方平台验证用，路径与内容固定；若不再需要可删除本段）
    if (request.method === 'GET' && url.pathname === '/a9a015a0f6e7c9ca09f4cdce4479deb3.txt') {
      return new Response('b7aa7e3069358c2c18f7908a7d5815788bafd020', { headers: TEXT_HEADERS });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ================= PWA 路由 =================
    if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST_JSON, { headers: MANIFEST_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/sw.js') {
      return new Response(SW_JS.replaceAll('{{PWA_VERSION}}', getPwaVersion()), { headers: SW_HEADERS });
    }

    if (request.method === 'GET' && ICON_B64[url.pathname]) {
      const bytes = getIconBytes(url.pathname);
      if (bytes) return new Response(bytes, { headers: PNG_HEADERS });
    }

    // 健康探针：供前端与 Service Worker 判断服务端是否可达。
    // ⚠️ SW 中必须显式放行该路径且绝不缓存，否则探针会被缓存应答 →
    //    永远「探测成功」→ 自动重连逻辑形同虚设。
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: HEALTH_HEADERS });
    }

    // v6.6.2: 删除 Web 会话时同步清理 R2 上的 Agent 长期记忆
    //（索引 kb/agent_mem_web_<sessionId> + 镜像目录 kb/mem/web_<sessionId>/）。
    // 注意内存缓存也要清，否则下次 remember 会把删掉的记忆从缓存里复活写回去。
    if (request.method === 'DELETE' && url.pathname === '/api/web-memory') {
      const denied = denyUnauthorized(env, request);
      if (denied) return denied;

      const sid = String(url.searchParams.get('session_id') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      if (!sid) {
        return new Response(JSON.stringify({ error: '缺少 session_id' }), { status: 400, headers: CORS_HEADERS });
      }
      const webChatId = 'web_' + sid;
      tgAgentMemCache.delete(webChatId);
      await storeDelete(env, agentMemKey(webChatId));
      await kbDeleteMemDir(env, webChatId); // v6.6.7：同步清空该会话的 md 镜像目录
      return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const denied = denyUnauthorized(env, request);
      if (denied) return denied;

      if (hitRateLimit(request, env)) {
        return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" }), {
          status: 429, headers: CORS_HEADERS,
        });
      }

      try {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "无效的请求格式" }), { status: 400, headers: CORS_HEADERS });
        }

        const aiConfig = buildAIRequest(env, body.model, body.messages, body.agent !== true);
        if (aiConfig.error) {
          return new Response(JSON.stringify({ error: aiConfig.error }), { status: 500, headers: CORS_HEADERS });
        }

        const { apiUrl, currentApiKey, payload, isImageAPI } = aiConfig;

        // v6.6.0: Web 端 Agent 模式 —— 复用 Telegram 同一套 ReAct 循环 + 工具链，
        // 进度通过 SSE 事件推送。记忆按 Web 会话隔离（web_<sessionId>），与 Telegram 互不干扰。
        // Web 是浏览器长连接（无 Telegram 的 60 秒重发问题），用完整 AGENT_TIMEOUT_MS 预算。
        if (body.agent === true && !isImageAPI) {
          return await handleWebAgent(env, body);
        }

        const upstreamResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentApiKey}`, 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

        if (!upstreamResponse.ok) {
          const errText = await upstreamResponse.text();
          return new Response(JSON.stringify({ error: `API 报错 (${upstreamResponse.status}):${errText}` }), {
            status: upstreamResponse.status,
            headers: CORS_HEADERS,
          });
        }

        if (!isImageAPI) {
          return new Response(upstreamResponse.body, { headers: SSE_HEADERS });
        } else {
          const responseData = await upstreamResponse.json();
          let imageUrlOrText = "图片生成失败或未返回格式";
          
          if (responseData.data && responseData.data[0]?.url) {
            imageUrlOrText = `![生成结果](${responseData.data[0].url})`;
          } else if (responseData.choices && responseData.choices[0]?.message) {
            imageUrlOrText = responseData.choices[0].message.content;
          }

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const fakeChunk = JSON.stringify({ choices: [{ delta: { content: imageUrlOrText + "\n\n" } }] });
              controller.enqueue(encoder.encode(`data: ${fakeChunk}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return new Response(stream, { headers: SSE_HEADERS });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const { models } = getChannelConfig(env);

      const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      let optionsHtml = '';
      for (let i = 0; i < models.length; i++) {
        const item = models[i];
        let displayName = item.name;
        if (!item.original.includes(':')) {
          displayName = item.id.length > 24 ? item.id.substring(0, 22) + '...' : item.id;
        }
        optionsHtml += `<option value="${escHtml(item.id)}" ${i === 0 ? 'selected' : ''}>${escHtml(displayName)}</option>`;
      }

      if (models.length === 0) {
        optionsHtml = '<option value="" disabled selected>未配置模型，请检查环境变量</option>';
      }

      const html = HTML_CONTENT.replaceAll('{{MODEL_OPTIONS}}', optionsHtml).replaceAll('{{APP_VERSION}}', APP_VERSION);
      return new Response(html, { headers: HTML_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      // Webhook 来源校验：配置 TG_WEBHOOK_SECRET 后，只接受携带正确
      // X-Telegram-Bot-Api-Secret-Token 请求头的调用（setWebhook 时传入 secret_token）。
      // 未配置时保持开放（兼容旧部署），但强烈建议配置。
      if (env.TG_WEBHOOK_SECRET) {
        const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
          return new Response('Forbidden', { status: 403 });
        }
      } else if (env.TG_BOT_TOKEN && !warnedNoWebhookSecret) {
        // v6.8.1：未配置 TG_WEBHOOK_SECRET 时 /tg-webhook 完全开放，任何人可伪造 update
        // 烧你的 API 配额、污染知识库；这里打一次日志提醒（wrangler tail 可见）
        warnedNoWebhookSecret = true;
        console.log('⚠️ [cloudflare-chat] 未配置 TG_WEBHOOK_SECRET，/tg-webhook 处于开放状态；强烈建议配置 secret_token 并用 setWebhook 重新绑定，同时可配 TG_ALLOWED_CHAT_IDS 白名单只允许自己的聊天。');
      }

      try {
        const update = await request.json();
        if (!env.TG_BOT_TOKEN) return new Response('OK', { status: 200 });

        // Telegram Bot API 单次调用超时（默认 15 秒，可用 TG_API_TIMEOUT_MS 调整）：
        // 之前是裸 fetch 无超时，api.telegram.org 偶发 hung 住会让进度消息永远停在"思考中"
        let tgApiTimeoutMs = parseInt(env.TG_API_TIMEOUT_MS || '15000', 10);
        if (!(tgApiTimeoutMs > 0)) tgApiTimeoutMs = 15000;
        const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(tgApiTimeoutMs)
        });

        // v6.4.3 根因修复：之前收到 webhook 立刻返回 OK、把全部工作丢进 ctx.waitUntil ——
        // 但 HTTP 响应结束后 waitUntil 最多再延续约 30 秒，超过 30 秒的 Agent 任务会被
        // 静默掐断（pending 消息永远卡在"📄 正在读取网页…"，且无任何错误）。
        // 现在改为在请求上下文内等待处理完成再返回 OK。
        async function processTelegramUpdate(env, update, tgApi) {
          try {
            const { models: modelObjList } = getChannelConfig(env);
            if (modelObjList.length === 0) return;

            // v6.8.1 聊天白名单（可选）：配置 TG_ALLOWED_CHAT_IDS（逗号分隔的数字 ID）后，
            // 只响应名单内的聊天，其他一律静默忽略（仍返回 OK，避免 Telegram 反复重发）。
            // 不配置则保持原有开放行为。个人自用强烈建议配置，只填自己的 chat id。
            const allowedChatIds = parseCommaSeparated(env.TG_ALLOWED_CHAT_IDS);
            const isChatAllowed = (cid) => !allowedChatIds.length || allowedChatIds.indexOf(String(cid)) !== -1;

            if (update.callback_query) {
              const cb = update.callback_query;
              // inline 模式的回调没有 message，直接回包消掉 loading 状态后忽略
              const chatId = cb.message && cb.message.chat ? cb.message.chat.id : undefined;
              if (chatId === undefined || !isChatAllowed(chatId)) {
                try { await tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {}); } catch (e) {}
                return;
              }
              const data = cb.data;

              if (data.startsWith('M:')) {
                const index = parseInt(data.substring(2), 10);
                if (modelObjList[index]) {
                  const selected = modelObjList[index];
                  mapSetBounded(tgUserModels, chatId, selected.id);
                  await storePut(env, `tg_user_${chatId}`, selected.id);

                  await tgApi('sendMessage', {
                    chat_id: chatId,
                    text: `✅ **已切换模型为:** \n\`${selected.name}\``,
                    parse_mode: "Markdown"
                  }).catch(() => {});
                }
              }

              await tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
              return;
            }

            if (update.message && update.message.text) {
              const chatId = update.message.chat.id;
              if (!isChatAllowed(chatId)) return; // 不在白名单：静默忽略
              const userText = update.message.text;

              // v6.8.1：精确匹配命令，避免 /startfoo 之类被误判；
              // 兼容群组里的 /start@botname 写法
              const isCmd = (t, cmd) => t === cmd || t.startsWith(cmd + ' ') || t.startsWith(cmd + '@');
              if (isCmd(userText, '/start') || isCmd(userText, '/model')) {
                const inline_keyboard = modelObjList.map((model, index) => {
                  return [{ text: model.name, callback_data: `M:${index}` }];
                });

                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: "⚙️ **请选择对话要使用的 AI 模型:**\n\n_支持多轮对话（最近 " + (parseInt(env.TG_HISTORY_ROUNDS || '10', 10) || 10) + " 轮），发送 /clear 可清空上下文。_\n\n🤖 **Agent 模式**（默认开启）：我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🧮 精确计算、🌤 天气、🕐 时间），并用 🧠 长期记住你告诉我的事、用 💾📚 存取知识库文档。发送 /agent 可切换为普通对话模式，/help 查看全部命令。",
                  parse_mode: "Markdown",
                  reply_markup: { inline_keyboard }
                });
                return;
              }

              if (userText === '/clear' || userText === '/new') {
                await tgClearHistory(env, chatId);
                await agentClearResumeState(env, chatId);
                await tgApi('sendMessage', { chat_id: chatId, text: "🧹 上下文已清空，可以开始新的话题了。" });
                return;
              }

              if (userText === '/help') {
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: "🤖 命令列表：\n\n"
                    + "/start、/model —— 选择对话模型\n"
                    + "/agent —— 切换 Agent / 普通对话模式\n"
                    + "/clear —— 清空当前对话上下文\n"
                    + "/memory —— 查看长期记忆\n"
                    + "/forget 关键词 —— 删除包含关键词的记忆\n"
                    + "/kb —— 知识库总览（文档列表 + 记忆统计）\n"
                    + "任务太长被暂停时，发送「继续」可接着做\n\n"
                    + "Agent 模式下我会自主规划、调用工具（🔍 搜索、📄 网页、🧮 计算、🌤 天气、🕐 时间），长期记住你告诉我的事，还能用 💾 保存、📚 查阅知识库文档（比如：把这篇文章存成知识库文档；问知识库里的问题我会优先查文档）。"
                    + "\n\n📌 当前版本 v" + APP_VERSION + "（R2 持久化 · 长期记忆无上限）"
                });
                return;
              }

              if (userText === '/memory') {
                const mems = await agentGetMemories(env, chatId);
                if (!mems.length) {
                  await tgApi('sendMessage', { chat_id: chatId, text: "🧠 暂无长期记忆。\n\n对我说「记住xxx」即可保存，比如：记住，我养了一只猫叫汤圆" });
                } else {
                  let text = '🧠 长期记忆（共' + mems.length + '条）：\n';
                  mems.forEach((mm, i) => { text += (i + 1) + '. ' + mm.fact + '\n'; });
                  text += '\n用 /forget 关键词 删除记忆。';
                  for (let s = 0; s < text.length; s += 4000) {
                    await tgApi('sendMessage', { chat_id: chatId, text: text.slice(s, s + 4000) });
                  }
                }
                return;
              }

              if (userText === '/kb') {
                const mems = await agentGetMemories(env, chatId);
                let text = '📚 知识库总览\n\n';
                text += '🧠 长期记忆：共' + mems.length + '条（/memory 查看，/forget 关键词 删除）\n\n';
                text += await toolListDocs(env);
                text += '\n\n💾 保存文档：对我说"把…存成知识库文档"；🗑️ 删文档：说"删除知识库文档《标题》"';
                for (let s = 0; s < text.length; s += 4000) {
                  await tgApi('sendMessage', { chat_id: chatId, text: text.slice(s, s + 4000) });
                }
                return;
              }

              if (userText.startsWith('/forget')) {
                const kw = userText.slice(7).trim();
                if (!kw) {
                  await tgApi('sendMessage', { chat_id: chatId, text: "用法：/forget 关键词\n例如：/forget 猫 —— 删除所有包含「猫」的记忆" });
                } else {
                  const rr = await agentForgetMemory(env, chatId, kw);
                  await tgApi('sendMessage', {
                    chat_id: chatId,
                    text: rr.persistError ? '⚠️ ' + rr.persistError : (rr.removed > 0 ? '🗑 已删除 ' + rr.removed + ' 条包含「' + kw + '」的记忆。' : '没有找到包含「' + kw + '」的记忆。')
                  });
                }
                return;
              }

              if (userText === '/agent') {
                const cur = await agentGetMode(env, chatId);
                await agentSetMode(env, chatId, !cur);
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: !cur
                    ? "🤖 **Agent 模式已开启**\n\n我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🧮 精确计算、🌤 天气、🕐 时间），长期记住你告诉我的重要信息，还能用 💾 保存、📚 查阅知识库文档。"
                    : "💬 **已切换为普通对话模式**\n\n单轮问答，不调用工具、不使用长期记忆。如需 Agent 能力再发送 /agent 切回。",
                  parse_mode: "Markdown"
                });
                return;
              }

              let targetModelId = tgUserModels.get(chatId);
              if (!targetModelId) {
                targetModelId = await storeGet(env, `tg_user_${chatId}`);
              }

              // 多轮对话：取出历史，拼上本轮用户消息（超限自动裁剪）
              let history = await tgGetHistory(env, chatId);
              history.push({ role: "user", content: userText });
              history = tgTrimHistory(history, env);

              const sendActionPromise = tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
              const pendingMsgPromise = tgApi('sendMessage', {
                chat_id: chatId,
                text: "⏳ _正在思考并生成内容，请稍候..._",
                parse_mode: "Markdown"
              }).then(async res => {
                if (res.ok) {
                  const data = await res.json();
                  return data.result?.message_id;
                }
                return null;
              }).catch(() => null);

              const [, pendingMsgId] = await Promise.all([sendActionPromise, pendingMsgPromise]);

              // ===== Agent 主流程：自主规划 → 工具调用 → 汇总作答 =====
              const useAgent = await agentGetMode(env, chatId);
              let replyText = null;
              let agentErr = null;

              // webhook 单轮预算：Telegram 约 60 秒无响应会重发 update，
              // 55 秒内必须返回（可用 TG_WEBHOOK_BUDGET_MS 调整，10 秒 ~ 240 秒）。
              // 超预算的任务会暂停并保存进度，用户发「继续」即接着做。
              let webhookBudgetMs = parseInt(env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
              if (!(webhookBudgetMs >= 10000)) webhookBudgetMs = 55000;
              if (webhookBudgetMs > 240000) webhookBudgetMs = 240000;
              const agentOpts = { maxRuntimeMs: webhookBudgetMs, resumeKey: tgAgentResumeKey(chatId) };

              if (useAgent) {
                // Agent 模式：ReAct 多步推理 + 工具调用（进度实时编辑到 pending 消息上）
                let lastProgressEdit = 0;
                const onProgress = async (text, force) => {
                  if (!pendingMsgId) return;
                  const now = Date.now();
                  if (!force && now - lastProgressEdit < 1500) return; // Telegram 编辑限流，节流；工具进度用 force 突破
                  lastProgressEdit = now;
                  try {
                    // 纯文本，不加 parse_mode，避免搜索词里的 Markdown 特殊字符导致编辑失败
                    await tgApi('editMessageText', { chat_id: chatId, message_id: pendingMsgId, text: String(text).slice(0, 4000) });
                  } catch (e) {}
                };
                // 「继续」：恢复上次暂停的任务；新问题则清掉旧暂停状态
                const wantResume = /^继续/.test(userText.trim());
                let resumeState = null;
                if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
                if (!resumeState) await agentClearResumeState(env, chatId);
                const runAgentTurn = (allowTools) => {
                  if (resumeState) {
                    return tgAgentResume(env, tgApi, chatId, {
                      targetModelId: resumeState.targetModelId || targetModelId,
                      allowTools: allowTools,
                      messages: resumeState.messages
                    }, onProgress, agentOpts);
                  }
                  return tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, agentOpts);
                };
                let r;
                try {
                  r = await runAgentTurn(true);
                  if (r.fallback) r = await runAgentTurn(false);
                } catch (e) {
                  // 兜底：Agent 内部任何未预期异常都转为可见错误，绝不让用户面对卡死的"思考中"
                  r = { error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) };
                }
                if (r.error) {
                  agentErr = r.error;
                } else {
                  replyText = r.text;
                  // 文本问答记入历史；图片生成不记（省空间）
                  if (!r.isImage && replyText) {
                    history.push({ role: "assistant", content: replyText });
                    history = tgTrimHistory(history, env);
                    await tgSaveHistory(env, chatId, history);
                  }
                  // 正常完成（非暂停）后清理断点；暂停时新状态已在内部保存
                  if (!r.paused) await agentClearResumeState(env, chatId);
                }
              } else {
                // 普通模式：单次问答（与旧版行为一致，不调用工具）
                const aiConfig = buildAIRequest(env, targetModelId, history, false);
                if (aiConfig.error) {
                  if (pendingMsgId) {
                    tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
                  }
                  await tgApi('sendMessage', { chat_id: chatId, text: "⚠️ 此模型的 API 接口未配置或异常。" });
                  return;
                }
                const { apiUrl, currentApiKey, payload } = aiConfig;
                // 上游偶发中断时重试一次（深度思考时间越长越容易撞上）
                let aiResponse = null;
                for (let tgAttempt = 1; tgAttempt <= 2; tgAttempt++) {
                  try {
                    aiResponse = await fetch(apiUrl, {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${currentApiKey}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(payload),
                      signal: AbortSignal.timeout(60000) // 普通对话上游单次调用上限 60 秒
                    });
                    break;
                  } catch (e) {
                    aiResponse = null;
                    if (tgAttempt >= 2) { agentErr = '上游接口请求失败，请稍后再试。'; break; }
                    await new Promise(function (r) { setTimeout(r, 1500); });
                  }
                }
                if (!agentErr) {
                  if (aiResponse && aiResponse.ok) {
                    const aiData = await aiResponse.json();
                    if (aiData.choices && aiData.choices[0]?.message) {
                      replyText = aiData.choices[0].message.content;
                    } else if (aiData.data && aiData.data[0]?.url) {
                      replyText = `[🖼️ 点击查看生成的图片](${aiData.data[0].url})`;
                    } else {
                      replyText = "AI 没有返回有效内容。";
                    }
                    if (aiData.choices && aiData.choices[0]?.message && replyText) {
                      history.push({ role: "assistant", content: replyText });
                      history = tgTrimHistory(history, env);
                      await tgSaveHistory(env, chatId, history);
                    }
                  } else {
                    agentErr = "⚠️ AI 接口请求失败，请稍后再试。";
                  }
                }
              }

              if (pendingMsgId) {
                await tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
              }

              if (agentErr) {
                await tgApi('sendMessage', { chat_id: chatId, text: agentErr });
                return;
              }

              if (replyText) {
                // 最终回复发送：带一次重试。tgApi 有 15 秒超时，一次偶发 hung 不该直接丢掉用户回复
                const sendReplyChunk = async (text, useMarkdown) => {
                  for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                      const r = await tgApi('sendMessage', useMarkdown
                        ? { chat_id: chatId, text, parse_mode: "Markdown" }
                        : { chat_id: chatId, text });
                      if (r.ok || attempt === 2) return r;
                    } catch (e) {
                      if (attempt === 2) return { ok: false };
                    }
                    await new Promise(function (rr) { setTimeout(rr, 800); });
                  }
                  return { ok: false };
                };
                const maxLength = 4000;
                let startIndex = 0;
                while (startIndex < replyText.length) {
                  let sliceLength = maxLength;
                  if (startIndex + maxLength < replyText.length) {
                    const lastNewline = replyText.lastIndexOf('\n', startIndex + maxLength);
                    if (lastNewline > startIndex + 3000) {
                       sliceLength = lastNewline - startIndex;
                    }
                  }

                  const chunk = replyText.slice(startIndex, startIndex + sliceLength);
                  startIndex += sliceLength;

                  const tgRes = await sendReplyChunk(chunk, true);

                  if (!tgRes.ok) {
                    await sendReplyChunk(chunk, false);
                  }
                }
              }
            }
          } catch (err) {
            console.log("后台处理异常:", err);
          }
        }

        // update_id 去重（v6.6.3 起改用内存，不再写 R2，避免 tg_update_* 无上限堆积）：
        // 同一 update 10 分钟内只处理一次。处理改为在请求内等待完成，
        // 响应变慢时 Telegram 可能重发 update，去重可避免重复执行 Agent / 重复发送回复。
        try {
          const uid = update && update.update_id;
          if (uid !== undefined && uid !== null) {
            const now = Date.now();
            // 顺手清理过期条目（>10 分钟），防止 Map 无限增长
            for (const [k, t] of seenUpdateIds) {
              if (now - t > 600000) seenUpdateIds.delete(k);
            }
            if (seenUpdateIds.has(uid)) return new Response('OK', { status: 200 });
            seenUpdateIds.set(uid, now);
          }
        } catch (e) {}

        try {
          await processTelegramUpdate(env, update, tgApi);
        } catch (err) {
          console.log("处理 Telegram 更新异常:", err);
        }

        return new Response('OK', { status: 200 });
      } catch (error) {
        return new Response('Error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ================= PWA：Web App Manifest =================
const MANIFEST_JSON = JSON.stringify({
  name: 'Cloudflare-Chat',
  short_name: 'CF-Chat',
  description: '基于 Cloudflare Workers 的多通道 AI 对话前端',
  lang: 'zh-CN',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#f8fafc',
  theme_color: '#3b82f6',
  categories: ['productivity', 'utilities'],
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: '发起新对话', short_name: '新对话', url: '/?new=1' },
  ],
});

// ================= PWA：Service Worker 源码 =================
// ⚠️ 本段位于外层模板字符串内部，只有【一层】转义，但仍需遵守：
//    1) 不得出现反引号（会截断外层模板字符串）—— 一律用单引号 + 字符串拼接；
//    2) 不得出现 ${（会被当成插值）—— 用 + 拼接；
//    3) 不得出现反斜杠 —— 避免二次转义歧义。
// 因此下面的 OFFLINE_HTML 用数组 join 构造，且不含任何内联脚本。
const SW_JS = `/* Cloudflare-Chat Service Worker —— 由 _worker.js 内嵌生成，请勿单独维护此文件 */
const VERSION = '{{PWA_VERSION}}';
const CACHE = 'cloudflare-chat-' + VERSION;
const SHELL = '/';

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const OFFLINE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head><meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta http-equiv="refresh" content="5">',
  '<title>离线中 - Cloudflare-Chat</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#f8fafc;color:#0f172a;',
  'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
  '.box{text-align:center;padding:40px 32px;max-width:360px}',
  '.dot{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;',
  'background:linear-gradient(135deg,#3b82f6,#6366f1);',
  'display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;font-weight:700}',
  'h1{font-size:18px;margin:0 0 10px}',
  'p{font-size:13px;color:#475569;line-height:1.7;margin:0}',
  '</style></head><body><div class="box">',
  '<div class="dot">!</div>',
  '<h1>当前处于离线状态</h1>',
  '<p>页面资源已缓存，但网络暂不可用。<br>本页每 5 秒自动重试一次，恢复后会自动刷新。</p>',
  '</div></body></html>'
].join('');

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // 应用外壳：任一失败不影响整体安装
    await Promise.all(PRECACHE.map(async function (u) {
      try { await cache.add(new Request(u, { cache: 'reload' })); } catch (e) {}
    }));
    // 第三方资源：离线时页面仍要能渲染 Markdown 与代码高亮
    await Promise.all(CDN_ASSETS.map(async function (u) {
      try {
        const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(u, res);
      } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('cloudflare-chat-') === 0) return caches.delete(k);
      return Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 健康探针：显式放行且绝不缓存。
  // 若在此处 respondWith 并缓存，探针会永远「成功」，自动重连将完全失效。
  if (url.pathname === '/healthz') return;

  // 实时接口：直连网络，不缓存
  if (url.pathname.indexOf('/api/') === 0) return;
  if (url.pathname === '/tg-webhook') return;

  // 页面导航：network-first，断网时回退到缓存的页面外壳
  if (req.mode === 'navigate') {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(SHELL, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(SHELL);
        if (cached) return cached;
        return new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
    })());
    return;
  }

  // 同源静态资源（图标 / manifest）：cache-first
  if (url.origin === self.location.origin) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  // 第三方 CDN：stale-while-revalidate
  if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(function () { return null; });
      if (cached) return cached;
      const res = await network;
      return res || Response.error();
    })());
  }
});
`;

// ================= UI 代码 =================
// 彻底清除了前端代码中所有可能被转义破坏的反引号，确保100%部署通过
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Cloudflare-Chat</title>

  <!-- ===== PWA ===== -->
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Cloudflare-Chat">
  <meta name="application-name" content="Cloudflare-Chat">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="apple-touch-icon" href="/icon-192.png">
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css">
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>

  <style>
    :root {
      --bg-base: #f8fafc;
      --glass-bg: rgba(255, 255, 255, 0.75);
      --glass-border: rgba(255, 255, 255, 0.8);
      --glass-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.08), 0 0 20px rgba(255, 255, 255, 0.5) inset;
      --text-main: #0f172a;
      --text-secondary: #475569;
      --brand-color: #3b82f6;
      --brand-gradient: linear-gradient(135deg, #3b82f6, #6366f1);
      --user-msg: var(--brand-gradient);
      --user-text: #ffffff;
      --input-bg: rgba(255, 255, 255, 0.95);
      --hover-bg: rgba(15, 23, 42, 0.04);
      --aurora-1: #e0e7ff;
      --aurora-2: #dbeafe;
      --aurora-3: #f3e8ff;
      --border-radius: 20px;
    }

    [data-theme="dark"] {
      --bg-base: #0f172a;
      --glass-bg: rgba(30, 41, 59, 0.7);
      --glass-border: rgba(255, 255, 255, 0.05);
      --glass-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5), 0 0 20px rgba(255, 255, 255, 0.02) inset;
      --text-main: #f1f5f9;
      --text-secondary: #94a3b8;
      --brand-color: #60a5fa; 
      --brand-gradient: linear-gradient(135deg, #3b82f6, #4f46e5);
      --user-msg: var(--brand-gradient);
      --user-text: #ffffff;
      --input-bg: rgba(30, 41, 59, 0.95);
      --hover-bg: rgba(255, 255, 255, 0.08);
      --aurora-1: #1e1b4b;
      --aurora-2: #0f172a;
      --aurora-3: #312e81;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--text-secondary); border-radius: 10px; opacity: 0.2; }
    ::-webkit-scrollbar-thumb:hover { background: var(--brand-color); }
    
    body, html {
      margin: 0; padding: 0; height: 100vh; height: 100dvh; 
      width: 100%; max-width: 100vw; overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--text-main); background-color: var(--bg-base); transition: background-color 0.5s ease;
    }

    @keyframes float1 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(30px, -30px) scale(1.05); } }
    @keyframes float2 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-30px, 20px) scale(1.1); } }
    @keyframes float3 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(20px, 40px) scale(0.95); } }

    .aurora-bg {
      position: fixed; top: 0; left: 0; width: 100%; height: 100vh; z-index: -1; pointer-events: none;
      filter: blur(80px); opacity: 0.8; transition: opacity 0.8s ease; overflow: hidden;
    }
    .aurora-blob { position: absolute; border-radius: 50%; opacity: 0.6; mix-blend-mode: multiply; }
    [data-theme="dark"] .aurora-blob { mix-blend-mode: screen; opacity: 0.4; }
    .blob-1 { top: -10%; left: -10%; width: 50vw; height: 50vw; background: var(--aurora-1); animation: float1 15s infinite ease-in-out; }
    .blob-2 { top: 40%; right: -20%; width: 60vw; height: 60vw; background: var(--aurora-2); animation: float2 18s infinite ease-in-out; }
    .blob-3 { bottom: -20%; left: 20%; width: 50vw; height: 50vw; background: var(--aurora-3); animation: float3 20s infinite ease-in-out; }

    .app-container { display: flex; height: 100%; width: 100%; max-width: 100vw; position: relative; overflow: hidden; }

    .sidebar {
      width: 280px; display: flex; flex-direction: column; z-index: 100;
      background: var(--glass-bg); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      border-right: 1px solid var(--glass-border); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), background 0.4s;
    }
    .sidebar-header { padding: 24px 20px 16px; }
    .new-chat-btn {
      width: 100%; padding: 14px; border-radius: 14px; border: 1px solid var(--glass-border);
      background: rgba(255,255,255,0.1); color: var(--text-main); font-weight: 600; font-size: 15px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .new-chat-btn:hover { background: var(--hover-bg); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    
    .session-list { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
    .session-item {
      padding: 14px 16px; border-radius: 12px; cursor: pointer; display: flex; justify-content: space-between; 
      align-items: center; font-size: 14px; color: var(--text-secondary); transition: all 0.2s ease;
      font-weight: 500; border: 1px solid transparent;
    }
    .session-item:hover { background: var(--hover-bg); color: var(--text-main); }
    .session-item.active { 
      background: var(--bg-base); color: var(--brand-color); font-weight: 600; 
      border-color: var(--glass-border); box-shadow: 0 2px 10px rgba(0,0,0,0.03);
    }
    .session-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .delete-btn { background: none; border: none; color: inherit; padding: 6px; cursor: pointer; opacity: 0; transition: all 0.2s; border-radius: 8px; }
    .session-item:hover .delete-btn { opacity: 0.5; }
    .delete-btn:hover { opacity: 1 !important; color: #ef4444; background: rgba(239, 68, 68, 0.1); }
    
    .sidebar-footer { padding: 16px 20px; border-top: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; }
    .theme-toggle { 
      background: none; border: none; color: var(--text-secondary); cursor: pointer; 
      display: flex; align-items: center; padding: 8px; border-radius: 10px; transition: all 0.2s; 
    }
    .theme-toggle:hover { background: var(--hover-bg); color: var(--brand-color); transform: scale(1.05); }
    .theme-toggle.active { color: var(--brand-color); background: var(--hover-bg); }
    .theme-toggle[hidden] { display: none; }

    /* ===== PWA：离线提示条 ===== */
    .offline-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600; letter-spacing: .2px;
      color: #ffffff; background: linear-gradient(90deg, #f59e0b, #ef4444);
      box-shadow: 0 4px 18px rgba(239, 68, 68, 0.28);
      transform: translateY(-105%); transition: transform .32s cubic-bezier(.4,0,.2,1);
      pointer-events: none;
    }
    .offline-banner.show { transform: translateY(0); }
    .offline-banner .spin { animation: offlineSpin 1s linear infinite; flex-shrink: 0; }
    @keyframes offlineSpin { to { transform: rotate(360deg); } }

    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 99; backdrop-filter: blur(4px); opacity: 0; transition: opacity 0.3s; }

    .chat-area { 
      flex: 1; display: flex; flex-direction: column; position: relative; 
      height: 100%; width: 100%; max-width: 100vw; overflow: hidden; 
    }
    
    .header { height: 70px; display: flex; align-items: center; padding: 0 24px; border-bottom: 1px solid var(--glass-border); background: var(--glass-bg); backdrop-filter: blur(20px); z-index: 10; }
    .header-inner { max-width: 880px; margin: 0 auto; width: 100%; display: flex; align-items: center; }
    .header-title { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 10px; color: var(--text-main); }
    
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.4); transition: all 0.3s; }
    @keyframes breathing { 
      0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); background: #3b82f6; } 
      70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); background: #60a5fa; } 
      100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); background: #3b82f6; } 
    }
    .status-dot.generating { animation: breathing 1.5s infinite; }

    .menu-toggle { background: none; border: none; color: var(--text-main); cursor: pointer; padding: 10px; margin-right: 12px; border-radius: 10px; display: none; transition: background 0.2s; }
    .menu-toggle:hover { background: var(--hover-bg); }
    
    .messages-container { 
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 32px 20px; scroll-behavior: smooth;
      contain: layout style; will-change: scroll-position;
      width: 100%;
    }
    .messages { max-width: 880px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 36px; }
    
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 65vh; opacity: 0.9; }
    .empty-state svg { color: var(--brand-color); width: 56px; height: 56px; margin-bottom: 24px; filter: drop-shadow(0 8px 16px rgba(59,130,246,0.2)); }
    .empty-state h2 { margin: 0; font-size: 24px; font-weight: 600; color: var(--text-main); letter-spacing: -0.5px; }
    
    .message-row { display: flex; width: 100%; max-width: 100%; animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; contain: content; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    
    .message-row.user { justify-content: flex-end; }
    
    .message-bubble { 
      line-height: 1.7; 
      word-wrap: break-word; word-break: break-word; overflow-wrap: break-word; 
      font-size: 16px; max-width: 100%; 
    }
    
    .message-row.user .message-bubble { 
      background: var(--user-msg); color: var(--user-text); max-width: 80%;
      padding: 14px 22px; 
      border-radius: 24px 24px 6px 24px; 
      white-space: pre-wrap; 
      box-shadow: 0 8px 24px -6px rgba(59, 130, 246, 0.25);
      font-weight: 400;
    }
    .message-row.ai .message-bubble { background: transparent; border: none; box-shadow: none; width: 100%; max-width: 100%; padding: 0; }
    .error-msg .message-bubble { color: #ef4444; }

    .markdown-body { font-size: 16px; line-height: 1.75; color: var(--text-main); font-family: inherit; word-break: break-word; max-width: 100%; }
    .markdown-body p { margin-top: 0; margin-bottom: 1.2em; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body a { color: var(--brand-color); text-decoration: none; font-weight: 500; word-break: break-all; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body strong { font-weight: 600; color: var(--text-main); }
    
    .markdown-body blockquote {
      margin: 16px 0; padding: 16px 20px; color: var(--text-secondary);
      border-left: 4px solid var(--brand-color); background: var(--hover-bg); border-radius: 0 12px 12px 0;
      font-style: italic; max-width: 100%; overflow-x: hidden;
    }
    .markdown-body ul, .markdown-body ol { margin-top: 0; margin-bottom: 1.2em; padding-left: 24px; }
    .markdown-body li { margin-bottom: 0.4em; }
    
    .markdown-body img, .markdown-body video { max-width: 100%; height: auto; border-radius: 8px; margin-top: 10px; }

    .markdown-body table { 
      display: block; overflow-x: auto; white-space: nowrap; 
      width: 100%; max-width: 100%; border-collapse: collapse; margin-bottom: 1.5em; 
      font-size: 15px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); 
      border: 1px solid var(--glass-border); 
    }
    .markdown-body th, .markdown-body td { border: 1px solid var(--glass-border); padding: 12px 16px; }
    .markdown-body th { background: var(--hover-bg); font-weight: 600; text-align: left; }

    .markdown-body code {
      background: var(--hover-bg); padding: 3px 6px; border-radius: 6px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.85em; color: var(--brand-color); font-weight: 500; word-break: break-all;
    }
    
    .code-wrapper { background: #0f172a; border-radius: 14px; overflow: hidden; margin: 20px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.1); max-width: 100%; }
    .code-header {
      display: flex; justify-content: space-between; align-items: center; padding: 10px 16px;
      background: rgba(255,255,255,0.05); color: #94a3b8; font-size: 13px; font-family: monospace; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .copy-btn {
      background: transparent; border: none; color: #94a3b8; cursor: pointer; display: flex; align-items: center; gap: 6px;
      font-size: 12px; transition: all 0.2s; padding: 6px 10px; border-radius: 6px; font-weight: 500;
    }
    .copy-btn:hover { color: #ffffff; background: rgba(255,255,255,0.1); }

    /* ===== 消息朗读按钮 ===== */
    .msg-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .speak-btn {
      background: transparent; border: 1px solid var(--glass-border); color: var(--text-secondary);
      cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
      padding: 6px 12px; border-radius: 10px; transition: all 0.2s ease; font-weight: 500;
      font-family: inherit; line-height: 1;
    }
    .speak-btn:hover { color: var(--brand-color); border-color: var(--brand-color); background: var(--hover-bg); }
    .speak-btn.speaking { color: var(--brand-color); border-color: var(--brand-color); background: var(--hover-bg); }
    .speak-btn.speaking svg { animation: speakPulse 1s infinite ease-in-out; }
    .speak-btn svg { flex-shrink: 0; }
    @keyframes speakPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .tts-warn { font-size: 12px; color: #ef4444; margin-top: 8px; }
    .retry-notice { font-size: 12px; color: var(--text-secondary); margin-top: 10px; padding: 8px 12px; background: var(--hover-bg); border-radius: 10px; animation: speakPulse 1.6s infinite ease-in-out; }
    .agent-progress { font-size: 12px; color: var(--text-secondary); margin-top: 10px; padding: 8px 12px; background: var(--hover-bg); border-radius: 10px; animation: speakPulse 1.6s infinite ease-in-out; white-space: pre-line; word-break: break-word; }
    .agent-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text-secondary); background: var(--hover-bg); border: 1px solid var(--border-color, #e2e8f0); border-radius: 999px; padding: 5px 12px; cursor: pointer; transition: all .2s; white-space: nowrap; }
    .agent-toggle:hover { color: var(--text-main); }
    .agent-toggle.active { color: #fff; background: linear-gradient(135deg, #3b82f6, #6366f1); border-color: transparent; }
    .code-wrapper pre { background: transparent !important; margin: 0 !important; padding: 20px; overflow-x: auto; border-radius: 0; box-shadow: none; max-width: 100%; }
    .code-wrapper pre code { background: transparent; padding: 0; color: #e2e8f0; font-size: 14px; line-height: 1.6; font-family: 'SFMono-Regular', Consolas, monospace; word-break: normal; }

    .reasoning-box {
      font-size: 14px; color: var(--text-secondary); background: rgba(128,128,128,0.05);
      padding: 12px 16px; border-radius: 12px; border-left: 3px solid var(--brand-color);
      margin-bottom: 16px; white-space: pre-wrap; line-height: 1.6; max-height: 150px; overflow-y: auto;
      overflow-x: hidden; word-break: break-word; max-width: 100%;
    }
    .reasoning-box::-webkit-scrollbar { width: 4px; }
    .reasoning-box::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 4px; }

    .typing-indicator { display: inline-flex; gap: 6px; align-items: center; padding: 4px 2px; height: 24px; }
    .typing-dot { width: 6px; height: 6px; background: var(--brand-color); border-radius: 50%; animation: typing 1.4s infinite ease-in-out both; }
    .typing-dot:nth-child(1) { animation-delay: -0.32s; }
    .typing-dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes typing { 0%, 80%, 100% { transform: scale(0); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }

    .input-wrapper { padding: 0 24px 32px; max-width: 900px; width: 100%; margin: 0 auto; position: relative; z-index: 10; box-sizing: border-box; }
    .input-box { 
      background: var(--input-bg); backdrop-filter: blur(24px); border: 1px solid var(--glass-border);
      border-radius: 24px; padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; 
      box-shadow: 0 12px 40px rgba(0,0,0,0.06), 0 2px 10px rgba(0,0,0,0.02); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); 
      width: 100%;
    }
    .input-box:focus-within { 
      border-color: var(--brand-color); 
      box-shadow: 0 12px 40px rgba(59, 130, 246, 0.12), 0 0 0 3px rgba(59, 130, 246, 0.1); 
      transform: translateY(-2px); 
    }
    
    .input-top { display: flex; align-items: flex-end; gap: 12px; }
    textarea { 
      flex: 1; background: transparent; border: none; color: var(--text-main); font-size: 16px; 
      line-height: 24px; max-height: 200px; min-height: 24px; resize: none; outline: none; 
      font-family: inherit; padding: 8px 0 8px 8px; font-weight: 400; width: 100%;
    }
    textarea::placeholder { color: var(--text-secondary); opacity: 0.6; }
    
    .send-btn { 
      width: 40px; height: 40px; border-radius: 20px; border: none; background: var(--hover-bg); 
      color: var(--text-secondary); display: flex; align-items: center; justify-content: center; 
      cursor: not-allowed; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); flex-shrink: 0; margin-bottom: 2px; 
    }
    .send-btn.active { 
      background: var(--brand-gradient); color: #ffffff; cursor: pointer; 
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
    }
    .send-btn.active:hover { transform: scale(1.08); box-shadow: 0 6px 16px rgba(59, 130, 246, 0.4); }

    .send-btn.stop-mode { 
      background: rgba(239, 68, 68, 0.1); 
      color: #ef4444; 
      cursor: pointer; 
      box-shadow: none;
    }
    .send-btn.stop-mode:hover { 
      background: rgba(239, 68, 68, 0.2); 
      transform: scale(1.08); 
    }
    .send-btn.stop-mode svg {
      fill: #ef4444;
      stroke: #ef4444;
    }
    
    .input-bottom { display: flex; justify-content: space-between; align-items: center; height: 28px; padding-top: 4px; width: 100%; }
    
    .model-selector-container { 
      display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 12px; 
      cursor: pointer; transition: all 0.2s; position: relative; overflow: hidden;
      background: var(--hover-bg); border: 1px solid transparent; max-width: 100%;
    }
    .model-selector-container:hover { background: rgba(128,128,128,0.1); border-color: var(--glass-border); }
    .model-select { 
      position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; 
      cursor: pointer; border: none; outline: none; -webkit-appearance: none; appearance: none;
    }
    .model-display-text { font-size: 13px; font-weight: 600; color: var(--text-secondary); pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
    
    .disclaimer { text-align: center; font-size: 12px; color: var(--text-secondary); opacity: 0.7; margin-top: 16px; font-weight: 500; }

    .settings-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      display: none; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .settings-modal-overlay.active { display: flex; opacity: 1; }
    .settings-box {
      background: var(--glass-bg); border: 1px solid var(--glass-border);
      box-shadow: var(--glass-shadow), 0 20px 40px rgba(0,0,0,0.1); padding: 30px; border-radius: 24px;
      width: 360px; max-width: 90%; transform: scale(0.95) translateY(10px); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .settings-modal-overlay.active .settings-box { transform: scale(1) translateY(0); }
    .settings-select {
      width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--glass-border);
      background: var(--input-bg); color: var(--text-main); font-size: 15px; outline: none;
      font-weight: 500; transition: all 0.2s; appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
      background-repeat: no-repeat; background-position: right 1rem center; background-size: 1em;
    }
    .settings-select:focus { border-color: var(--brand-color); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
    .settings-input {
      width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--glass-border);
      background: var(--input-bg); color: var(--text-main); font-size: 15px; outline: none;
      font-weight: 500; transition: all 0.2s; box-sizing: border-box; font-family: inherit;
    }
    .settings-input:focus { border-color: var(--brand-color); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
    .settings-hint { font-size: 12px; color: var(--text-secondary); opacity: 0.75; margin-top: 8px; line-height: 1.5; }
    .settings-btn {
      background: var(--brand-gradient); color: #fff; border: none; padding: 10px 24px;
      border-radius: 12px; cursor: pointer; font-size: 15px; font-weight: 600; transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
    }
    .settings-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(59, 130, 246, 0.3); }

    @media (min-width: 769px) {
      .app-container { padding: 24px; gap: 24px; align-items: center; justify-content: center; }
      .sidebar { position: relative; transform: translateX(0); border-radius: var(--border-radius); height: 100%; box-shadow: var(--glass-shadow); flex-shrink: 0; }
      .chat-area { border-radius: var(--border-radius); height: 100%; background: var(--glass-bg); backdrop-filter: blur(24px); border: 1px solid var(--glass-border); box-shadow: var(--glass-shadow); }
      .delete-btn { display: block; }
    }

    @media (max-width: 768px) {
      :root {
        --bg-base: #ffffff;
        --glass-bg: #ffffff;
        --glass-border: #e5e5e5;
        --glass-shadow: none;
        --input-bg: #f8fafc;
      }
      [data-theme="dark"] {
        --bg-base: #0f172a;
        --glass-bg: #0f172a;
        --glass-border: #334155;
        --input-bg: #1e293b;
      }

      body, html { background-color: var(--bg-base); }
      .app-container { display: flex; flex-direction: column; padding: 0; background: var(--bg-base); width: 100%; height: 100%; overflow: hidden; }
      .aurora-bg { display: none; }
      
      .sidebar { border-radius: 0; box-shadow: none; position: absolute; top: 0; left: 0; height: 100%; z-index: 100; border-right: 1px solid var(--glass-border); width: 280px; max-width: 85vw; transform: translateX(-100%); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
      .sidebar.open { transform: translateX(0); }
      .new-chat-btn { background: var(--input-bg); }
      .session-item.active { background: var(--hover-bg); }
      .delete-btn { display: block; opacity: 1; color: var(--text-secondary); background: none; }
      
      .sidebar-overlay { backdrop-filter: none; -webkit-backdrop-filter: none; }
      .sidebar-overlay.active { display: block; opacity: 1; }
      
      .chat-area { background: transparent; border: none; box-shadow: none; border-radius: 0; width: 100%; overflow: hidden; }
      .header { border-bottom: 1px solid transparent; height: 60px; padding: 0 16px; justify-content: flex-start; }
      .header-title { display: none; }
      .menu-toggle { display: flex; }
      
      .messages-container { padding: 0; width: 100%; overflow-x: hidden; }
      .messages { padding: 24px 16px; gap: 32px; max-width: 100vw; width: 100%; overflow-x: hidden; box-sizing: border-box; }
      .message-row.user .message-bubble { border-radius: 22px 22px 4px 22px; max-width: 92%; }
      
      .input-wrapper { padding: 8px 16px 12px 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); width: 100%; max-width: 100vw; background: var(--bg-base); box-sizing: border-box; }
      .input-box { border: 1px solid var(--glass-border); box-shadow: 0 -4px 20px rgba(0,0,0,0.03); border-radius: 24px; padding: 12px 16px 16px 16px; gap: 12px; width: 100%; box-sizing: border-box; }
      .input-box:focus-within { transform: none; }
      
      .send-btn.active:hover { transform: none; }
      .input-bottom { min-height: 28px; }
      .disclaimer { margin-top: 12px; }
    }
  </style>
</head>
<body>

<div class="offline-banner" id="offlineBanner" role="status" aria-live="polite">
  <svg class="spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
  <span id="offlineText">网络已断开，正在尝试重连…</span>
</div>

<div class="aurora-bg">
  <div class="aurora-blob blob-1"></div>
  <div class="aurora-blob blob-2"></div>
  <div class="aurora-blob blob-3"></div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>

<div class="settings-modal-overlay" id="settingsModal">
  <div class="settings-box">
    <h3 style="margin-top:0; font-size:20px; font-weight: 600; letter-spacing: -0.5px;">系统偏好设置</h3>
    <div style="margin-top: 20px;">
      <label style="font-size: 14px; font-weight: 500; color: var(--text-secondary); display: block; margin-bottom: 10px;">新对话默认模型</label>
      <select id="defaultModelSetting" class="settings-select">
        {{MODEL_OPTIONS}}
      </select>
    </div>
    <div style="margin-top: 20px;">
      <label style="font-size: 14px; font-weight: 500; color: var(--text-secondary); display: block; margin-bottom: 10px;">访问口令</label>
      <input type="password" id="accessTokenSetting" class="settings-input" placeholder="留空则不发送校验头" autocomplete="off">
      <div class="settings-hint">仅当服务端配置了 ACCESS_PASSWORD 时才需要填写，需与之一致。口令只保存在本机浏览器，不会上传。</div>
    </div>
    <div style="margin-top: 32px; text-align: right;">
      <button id="closeSettingsBtn" class="settings-btn">保存并关闭</button>
    </div>
  </div>
</div>

<div class="app-container">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <button class="new-chat-btn" id="newChatBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        发起新对话
      </button>
    </div>
    <div class="session-list" id="sessionList"></div>
    <div class="sidebar-footer">
      <div style="display: flex; gap: 6px; flex-shrink: 0;">
        <button class="theme-toggle" id="settingsToggle" title="系统设置">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
        <button class="theme-toggle" id="ttsToggle" title="自动朗读回复">
          <svg id="ttsIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>
        </button>
        <button class="theme-toggle" id="installBtn" title="安装到桌面 / 主屏幕" hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button class="theme-toggle" id="themeToggle" title="切换主题">
          <svg id="themeIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); font-weight: 600; white-space: nowrap; flex-shrink: 0;">Pro v{{APP_VERSION}}</div>
    </div>
  </div>

  <div class="chat-area">
    <div class="header">
      <div class="header-inner">
        <button class="menu-toggle" id="menuToggle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div class="header-title">
          <div class="status-dot" id="statusDot"></div>
          <span id="headerTitle">AI 核心处理中枢</span>
        </div>
      </div>
    </div>
    
    <div class="messages-container" id="scrollArea">
      <div class="messages" id="messages"></div>
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
        <h2>今天我能为你提供什么帮助？</h2>
      </div>
    </div>

    <div class="input-wrapper">
      <div class="input-box">
        <div class="input-top">
          <textarea id="userInput" placeholder="输入指令或开始对话..." rows="1"></textarea>
          <button class="send-btn" id="sendBtn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        
        <div class="input-bottom">
          <div class="model-selector-container">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand-color)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            <span class="model-display-text" id="modelDisplayText">加载中...</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6; pointer-events:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <select class="model-select" id="modelSelect">
              {{MODEL_OPTIONS}}
            </select>
          </div>
          <button class="agent-toggle" id="agentToggle" title="Agent 模式：自主规划并调用工具（🔍 搜索 / 📄 网页 / 🧮 计算 / 🌤 天气 / 🕐 时间），还能长期记住你告诉它的事">🤖 Agent</button>
        </div>
      </div>
      <div class="disclaimer">AI 生成的内容可能不准确，请核实重要信息。</div>
    </div>
  </div>
</div>

<script>
  let isCurrentlyStreaming = false;
  let currentAbortController = null; 

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  const ESCAPE_REG = /[&<>]/g;
  const escapeHtml = str => str.replace(ESCAPE_REG, m => ESCAPE_MAP[m]);

  // AI 输出统一走 safeHtml：先 Markdown 渲染，再做 XSS 清洗。
  // DOMPurify 经 CDN 加载；若加载失败则降级为"解析后取纯文本"，保证永远安全。
  // 注意：本段在外层模板字符串内，不写反斜杠、反引号，避免两层转义破坏代码。
  function safeHtml(mdText) {
    var raw = '';
    try { raw = marked.parse(mdText || ''); } catch (e) { raw = ''; }
    try {
      if (window.DOMPurify && window.DOMPurify.sanitize) return window.DOMPurify.sanitize(raw);
    } catch (e) {}
    var tmp = document.createElement('div');
    tmp.innerHTML = raw;
    return tmp.textContent || '';
  }

  const renderer = new marked.Renderer();
  renderer.code = function(code, language) {
    const displayLang = language || 'text';
    const escapedCode = escapeHtml(code);
    
    let highlightedCode = escapedCode;
    if (!isCurrentlyStreaming && language && hljs.getLanguage(language)) {
      try {
        highlightedCode = hljs.highlight(code, { language }).value;
      } catch (e) {}
    } else if (!isCurrentlyStreaming) {
      try {
        highlightedCode = hljs.highlightAuto(code).value;
      } catch (e) {}
    }
    
    // 使用纯字符串拼接，消灭反引号
    return '<div class="code-wrapper">' +
             '<div class="code-header">' +
               '<span>' + displayLang + '</span>' +
               '<button class="copy-btn" data-code="' + encodeURIComponent(code) + '">' +
                 '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                 '<span>复制代码</span>' +
               '</button>' +
             '</div>' +
             '<pre><code class="hljs ' + (language || '') + '">' + highlightedCode + '</code></pre>' +
           '</div>';
  };

  marked.setOptions({ breaks: true, renderer: renderer });

  document.addEventListener('click', function(e) {
    const copyBtn = e.target.closest('.copy-btn');
    if (!copyBtn) return;
    const code = decodeURIComponent(copyBtn.getAttribute('data-code'));
    navigator.clipboard.writeText(code).then(() => {
      const span = copyBtn.querySelector('span');
      const originalText = span.innerText;
      span.innerText = '已复制';
      setTimeout(() => { span.innerText = originalText; }, 2000);
    });
  });

  // ===== 语音朗读（Web Speech API，浏览器原生，无需任何 API Key）=====
  const TTS_AUTO_KEY = 'tts_auto';
  let autoSpeak = localStorage.getItem(TTS_AUTO_KEY) === '1';
  let activeSpeakBtn = null;

  const SPEAK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';

  function updateTtsToggleUI() {
    const btn = document.getElementById('ttsToggle');
    if (btn) {
      btn.classList.toggle('active', autoSpeak);
      btn.title = autoSpeak ? '自动朗读：已开启（点击关闭）' : '自动朗读：已关闭（点击开启）';
    }
  }

  // 把 Markdown / 代码块清理成适合朗读的纯文本
  // ⚠️ 本段位于外层模板字符串内部，存在「两层转义」：
  //    模板字符串吃掉一层反斜杠，浏览器解析 JS 字符串字面量再吃掉一层。
  //    因此这里【完全不写反斜杠】，一律用字符码拼接，避免正则被破坏。
  function cleanForSpeech(text) {
    if (!text) return '';
    const BT = String.fromCharCode(96);  // 反引号
    const BS = String.fromCharCode(92);  // 反斜杠
    const NL = String.fromCharCode(10);  // 换行
    const TAB = String.fromCharCode(9);
    // 用 @ 占位，展开成反斜杠；这样源码里不出现任何反斜杠
    const rx = function (p) { return p.split('@').join(BS); };

    const rules = [
      [BT + BT + BT + rx('[@s@S]*?') + BT + BT + BT, 'g', ' （代码块已省略） '],
      [BT + '([^' + BT + ']*)' + BT, 'g', '$1'],
      [rx('!@[[^@]]*@]@([^)]*@)'), 'g', ' （图片） '],
      [rx('@[([^@]]*)@]@([^)]*@)'), 'g', '$1'],
      [rx('^@s{0,3}#{1,6}@s*'), 'gm', ''],
      [rx('^@s{0,3}>@s?'), 'gm', ''],
      [rx('(@*@*|__)(.*?)@1'), 'g', '$2'],
      [rx('(@*|_)(.*?)@1'), 'g', '$2'],
      [rx('^@s*[-*+]@s+'), 'gm', ''],
      [rx('^@s*@d+@.@s+'), 'gm', ''],
      [rx('@|'), 'g', ' '],
      ['^[-=]{3,}$', 'gm', ' '],
      [rx('^[@s:-]*[-:][@s:-]*$'), 'gm', ''],
      ['[ ' + TAB + ']{2,}', 'g', ' '],
      [rx('@n{3,}'), 'g', NL + NL]
    ];

    let out = String(text);
    for (let i = 0; i < rules.length; i++) {
      try {
        out = out.replace(new RegExp(rules[i][0], rules[i][1]), rules[i][2]);
      } catch (e) { /* 单条规则异常不影响其余 */ }
    }
    return out.trim();
  }

  // 是否包含中日韩字符（用于选择朗读语言）
  function containsCJK(text) {
    const re = new RegExp('[' + String.fromCharCode(0x4e00) + '-' + String.fromCharCode(0x9fff) + ']');
    return re.test(text);
  }

  function getBubbleText(bubble) {
    const box = bubble.querySelector('.message-text') || bubble;
    return (box.innerText || box.textContent || '').trim();
  }

  function stopSpeaking() {
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (activeSpeakBtn) {
      activeSpeakBtn.classList.remove('speaking');
      const span = activeSpeakBtn.querySelector('span');
      if (span) span.textContent = '朗读';
      activeSpeakBtn = null;
    }
  }

  function toggleSpeak(btn, bubble) {
    if (btn.classList.contains('speaking')) { stopSpeaking(); return; }

    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      alert('当前浏览器不支持语音朗读，请使用 Chrome / Edge / Safari 较新版本。');
      return;
    }

    stopSpeaking();

    const text = cleanForSpeech(getBubbleText(bubble));
    if (!text) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = containsCJK(text) ? 'zh-CN' : 'en-US';
    utter.rate = 1;
    utter.pitch = 1;

    const reset = () => {
      if (activeSpeakBtn === btn) {
        btn.classList.remove('speaking');
        const span = btn.querySelector('span');
        if (span) span.textContent = '朗读';
        activeSpeakBtn = null;
      }
    };
    utter.onend = reset;
    utter.onerror = reset;

    activeSpeakBtn = btn;
    btn.classList.add('speaking');
    const span = btn.querySelector('span');
    if (span) span.textContent = '停止';

    window.speechSynthesis.speak(utter);
  }

  // 给每条 AI 消息挂上「朗读」按钮（幂等，可重复调用）
  function ensureSpeakButton(bubble) {
    if (!bubble || bubble.querySelector('.msg-actions')) return;
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.className = 'speak-btn';
    btn.type = 'button';
    btn.title = '朗读这条回复';
    btn.innerHTML = SPEAK_ICON + '<span>朗读</span>';
    btn.addEventListener('click', () => toggleSpeak(btn, bubble));
    actions.appendChild(btn);
    bubble.appendChild(actions);
  }

  // 会话本地存储：v6.1 起改用 cfchat_sessions；旧 key（nvidia_ai_sessions）的数据自动迁移
  const STORAGE_KEY = 'cfchat_sessions';
  const LEGACY_STORAGE_KEY = 'nvidia_ai_sessions';
  const MAX_SEND_MSGS = 60;   // 每次请求最多带最近 60 条消息，避免超长会话撑爆请求体
  const MAX_STORE_MSGS = 200; // 每个会话本地最多保留 200 条，超限从最旧开始丢弃
  function loadSessions() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
    } catch (e) {}
    return [];
  }
  let sessions = loadSessions();
  try {
    if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (e) {}
  let currentSessionId = null;

  // /api/chat 访问口令：存在本机浏览器，随请求以 X-Access-Token 头发出
  const ACCESS_TOKEN_KEY = 'access_token';
  let accessToken = localStorage.getItem(ACCESS_TOKEN_KEY) || '';

  const messagesDiv = document.getElementById('messages');
  const emptyState = document.getElementById('emptyState');
  const scrollArea = document.getElementById('scrollArea');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const sessionListDiv = document.getElementById('sessionList');
  const modelSelect = document.getElementById('modelSelect');
  const headerTitle = document.getElementById('headerTitle');
  const modelDisplayText = document.getElementById('modelDisplayText');
  const statusDot = document.getElementById('statusDot');
  
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');
  let currentTheme = localStorage.getItem('theme') || 'light';
  applyTheme(currentTheme);

  themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', currentTheme);
    applyTheme(currentTheme);
  });

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
    } else {
      document.body.removeAttribute('data-theme');
      themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
  }

  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    sendBtn.classList.toggle('active', this.value.trim().length > 0);
  });

  function init() {
    updateHeaderDisplay();
    if (sessions.length === 0) createNewSession();
    else switchSession(sessions[0].id);
    renderSessionList();
  }

  function saveSessions() {
    try {
      for (var i = 0; i < sessions.length; i++) {
        var msgs = sessions[i].messages;
        if (msgs && msgs.length > MAX_STORE_MSGS) {
          sessions[i].messages = msgs.slice(msgs.length - MAX_STORE_MSGS);
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {}
  }

  menuToggle.addEventListener('click', () => { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); });
  sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); });

  function updateHeaderDisplay() {
    if (modelSelect) {
      const selectedText = modelSelect.options[modelSelect.selectedIndex]?.text || 'AI 核心处理中枢';
      headerTitle.innerText = selectedText;
      if (modelDisplayText) modelDisplayText.innerText = selectedText;
    }
  }

  function createNewSession() {
    const newId = 'session_' + Date.now();
    const savedDefaultModel = localStorage.getItem('default_model');
    const fallbackModel = modelSelect.options.length > 0 ? modelSelect.options[0].value : "";
    const targetModel = savedDefaultModel || fallbackModel;

    sessions.unshift({ id: newId, title: '新对话', messages: [], model: targetModel });
    saveSessions();
    switchSession(newId);
    renderSessionList();
    if(window.innerWidth <= 768) sidebar.classList.remove('open');
  }

  function switchSession(id) {
    stopSpeaking();
    currentSessionId = id;
    const currentSession = sessions.find(s => s.id === id);
    if (currentSession && currentSession.model) {
      const exists = Array.from(modelSelect.options).some(opt => opt.value === currentSession.model);
      if (exists) {
        modelSelect.value = currentSession.model;
      } else {
        modelSelect.selectedIndex = 0;
        currentSession.model = modelSelect.value;
        saveSessions();
      }
    } else if (modelSelect.options.length > 0) {
      modelSelect.selectedIndex = 0;
    }
    updateHeaderDisplay();
    renderMessages();
    renderSessionList();
    if(window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); userInput.blur(); }
  }

  function onModelChange() {
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if(currentSession) {
      currentSession.model = modelSelect.value;
      saveSessions();
    }
    updateHeaderDisplay();
  }
  modelSelect.addEventListener('change', onModelChange);
  modelSelect.addEventListener('input', onModelChange);

  // v6.6.0: Web 端 Agent 模式开关（默认开启，与 Telegram 一致；记忆按 Web 会话隔离）
  const agentToggle = document.getElementById('agentToggle');
  let agentMode = localStorage.getItem('cfchat_agent_mode') !== '0';
  function renderAgentToggle() {
    if (!agentToggle) return;
    agentToggle.classList.toggle('active', agentMode);
    agentToggle.textContent = agentMode ? '🤖 Agent 开' : '🤖 Agent';
    agentToggle.title = agentMode
      ? 'Agent 模式已开启：自主规划并调用工具（🔍 搜索 / 📄 网页 / 🧮 计算 / 🌤 天气 / 🕐 时间），长期记住你告诉它的事。点击关闭。'
      : 'Agent 模式已关闭：普通对话，不调用工具。点击开启。';
  }
  if (agentToggle) {
    agentToggle.addEventListener('click', () => {
      agentMode = !agentMode;
      try { localStorage.setItem('cfchat_agent_mode', agentMode ? '1' : '0'); } catch (e) {}
      renderAgentToggle();
    });
    renderAgentToggle();
  }

  function deleteSession(e, id) {
    e.stopPropagation(); 
    if (!confirm('确认删除此记录吗？')) return;
    sessions = sessions.filter(s => s.id !== id); 
    saveSessions();
    // v6.6.2: 同步删除 R2 上的 Agent 长期记忆；失败也不影响本地删除
    try {
      const delHeaders = {};
      if (typeof accessToken !== 'undefined' && accessToken) delHeaders['X-Access-Token'] = accessToken;
      fetch('/api/web-memory?session_id=' + encodeURIComponent(id), { method: 'DELETE', headers: delHeaders }).catch(() => {});
    } catch (err) {}
    if (sessions.length === 0) createNewSession();
    else if (currentSessionId === id) switchSession(sessions[0].id);
    else renderSessionList();
  }

  function renderSessionList() {
    sessionListDiv.replaceChildren();
    const fragment = document.createDocumentFragment();

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item ' + (session.id === currentSessionId ? 'active' : '');
      item.onclick = () => switchSession(session.id);
      
      const titleSpan = document.createElement('span'); 
      titleSpan.className = 'session-title'; 
      titleSpan.innerText = session.title;
      
      const delBtn = document.createElement('button'); 
      delBtn.className = 'delete-btn'; 
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4h4v2"></path></svg>';
      delBtn.onclick = (e) => deleteSession(e, session.id);
      
      item.appendChild(titleSpan); 
      item.appendChild(delBtn); 
      fragment.appendChild(item);
    });

    sessionListDiv.appendChild(fragment);
  }

  function renderMessages() {
    messagesDiv.replaceChildren();
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (!currentSession) return;
    
    if (currentSession.messages.length === 0) {
      emptyState.style.display = 'flex';
    } else { 
      emptyState.style.display = 'none'; 
      currentSession.messages.forEach(msg => {
        const uiRole = msg.role === 'assistant' ? 'ai' : msg.role;
        appendMessageDOM(uiRole, msg.content, null, false);
      }); 
    }
  }

  function appendMessageDOM(role, content, msgId = null, isError = false) {
    let row = msgId ? document.getElementById('row_' + msgId) : null;
    let bubble = msgId ? document.getElementById(msgId) : null;
    
    if (!row) {
      row = document.createElement('div'); 
      row.className = 'message-row ' + role;
      if (msgId) row.id = 'row_' + msgId; 
      if (isError) row.classList.add('error-msg');
      
      bubble = document.createElement('div'); 
      bubble.className = 'message-bubble'; 
      if (msgId) bubble.id = msgId;
      
      row.appendChild(bubble); 
      messagesDiv.appendChild(row);
    }
    
    if (role === 'ai') {
      if (msgId) {
        bubble.innerHTML = content;
      } else {
        isCurrentlyStreaming = false;
        bubble.innerHTML = '<div class="message-text markdown-body">' + safeHtml(content) + '</div>';
        bubble.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      }
      ensureSpeakButton(bubble);
    } else {
      bubble.innerText = content; 
    }
    
    scrollArea.scrollTop = scrollArea.scrollHeight; 
    
    const rBox = bubble.querySelector('.reasoning-box');
    if (rBox) { rBox.scrollTop = rBox.scrollHeight; }

    return bubble;
  }

  async function sendMessage() {
    const text = userInput.value.trim(); 
    if (!text && !isCurrentlyStreaming) return;
    
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (currentSession.messages.length === 0) {
      currentSession.title = text.length > 14 ? text.substring(0, 14) + '...' : text;
      renderSessionList();
    }
    
    stopSpeaking();
    emptyState.style.display = 'none'; 
    userInput.value = ''; 
    userInput.style.height = 'auto';
    statusDot.classList.add('generating'); 
    
    appendMessageDOM('user', text);
    currentSession.messages.push({ role: 'user', content: text });
    saveSessions();

    const aiMsgId = 'ai_' + Date.now();
    // 字符串拼接替换模板字符串
    appendMessageDOM('ai', 
      '<div class="reasoning-box" style="display:none;"></div>' +
      '<div class="message-text markdown-body">' +
        '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
      '</div>', aiMsgId);
    
    const bubble = document.getElementById(aiMsgId);
    isCurrentlyStreaming = true;
    
    currentAbortController = new AbortController();
    sendBtn.classList.remove('active');
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg>';

    try {
      const reqHeaders = { 'Content-Type': 'application/json' };
      if (accessToken) reqHeaders['X-Access-Token'] = accessToken;

      let aiContent = '';
      let reasoningContent = '';
      let gotDone = false; // 是否收到 SSE 正常结束标记 data: [DONE]

      const rBox = bubble.querySelector('.reasoning-box');
      const tBox = bubble.querySelector('.message-text');

      let isRenderPending = false;
      let lastRenderTime = 0;
      const cursorHtml = '<span style="display:inline-block; width:6px; height:18px; background:var(--brand-color); animation:typing 1s infinite; vertical-align:middle; margin-left:4px; border-radius:2px;"></span>';

      function scheduleUpdateUI(force = false) {
        const now = Date.now();
        if (!force && now - lastRenderTime < 60) return;
        if (isRenderPending) return;
        isRenderPending = true;

        requestAnimationFrame(() => {
          isRenderPending = false;
          lastRenderTime = Date.now();

          if (!isCurrentlyStreaming && !force) return;

          if (reasoningContent && rBox) {
            if (rBox.style.display === 'none') rBox.style.display = 'block';
            rBox.textContent = reasoningContent;
            rBox.scrollTop = rBox.scrollHeight;
          }

          if (aiContent || !reasoningContent) {
            tBox.innerHTML = safeHtml(aiContent) + (isCurrentlyStreaming ? cursorHtml : '');
          } else if (reasoningContent && !aiContent) {
            tBox.innerHTML = '<div style="color: var(--brand-color); font-size: 14px; font-weight: 500;">正在深度思考... ▍</div>';
          }

          const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
          if (distanceToBottom < 120) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
          }
        });
      }

      // v6.6.0 Agent 进度条（气泡内，收到正文结束 / 出错 / 中止时清除）
      let agentProgressEl = null;
      function showAgentProgress(text) {
        if (!agentProgressEl) {
          agentProgressEl = document.createElement('div');
          agentProgressEl.className = 'agent-progress';
          bubble.appendChild(agentProgressEl);
        }
        agentProgressEl.textContent = text;
        const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
        if (distanceToBottom < 120) {
          scrollArea.scrollTop = scrollArea.scrollHeight;
        }
      }
      function clearAgentProgress() {
        if (agentProgressEl && agentProgressEl.parentNode) agentProgressEl.parentNode.removeChild(agentProgressEl);
        agentProgressEl = null;
      }

      // 自动重试提示条（只在断流重试时短暂出现）
      let retryNoticeEl = null;
      function setRetryNotice(text) {
        if (!text) {
          if (retryNoticeEl && retryNoticeEl.parentNode) retryNoticeEl.parentNode.removeChild(retryNoticeEl);
          retryNoticeEl = null;
          return;
        }
        if (!retryNoticeEl) {
          retryNoticeEl = document.createElement('div');
          retryNoticeEl.className = 'retry-notice';
          bubble.appendChild(retryNoticeEl);
        }
        retryNoticeEl.textContent = text;
      }

      // 重试前清空本轮残留，重新完整生成一次（避免新旧内容拼接错乱）
      function resetStreamUI() {
        aiContent = '';
        reasoningContent = '';
        gotDone = false;
        clearAgentProgress();
        if (rBox) { rBox.style.display = 'none'; rBox.textContent = ''; }
        tBox.innerHTML = '';
      }

      // 单次流式请求。收到 [DONE] 返回 true；网络/鉴权等错误直接 throw。
      // 注意：流被"静默掐断"（done=true 但无 [DONE]）不会抛错，由外层按 gotDone 判定。
      async function runOnce() {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            messages: currentSession.messages.slice(-MAX_SEND_MSGS),
            model: modelSelect.value,
            agent: agentMode,
            session_id: currentSessionId
          }),
          signal: currentAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '网络或服务接口错误' }));
          if (response.status === 401) {
            openSettings();
            const authErr = new Error('访问口令错误或未填写');
            authErr.name = 'AuthError';
            throw authErr;
          }
          throw new Error(errorData.error || '请求失败');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\\n');
          buffer = lines.pop();

          for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            // 结束标记：兼容 data:[DONE]（无空格）写法
            if (line.slice(5).trim() === '[DONE]') { gotDone = true; continue; }
            // v6.6.0 Agent 事件：进度展示 / 错误（错误直接抛给外层统一处理，不自动重试，避免工具重复执行）
            // v6.8.1：先做子串快速过滤，再要求整行是合法 JSON 且真的携带对应字段，
            // 避免 AI 正文恰好包含 "agent_progress" 子串时整行被误吞
            if (line.indexOf('"agent_progress"') > 0 || line.indexOf('"agent_error"') > 0) {
              let handledAsAgentEvent = false;
              try {
                const adata = JSON.parse(line.slice(5).trim());
                if (adata && adata.agent_progress !== undefined) {
                  showAgentProgress(adata.agent_progress);
                  handledAsAgentEvent = true;
                } else if (adata && adata.agent_error !== undefined) {
                  const ae = new Error(adata.agent_error);
                  ae.name = 'AgentError';
                  throw ae;
                }
              } catch (e) {
                if (e && e.name === 'AgentError') throw e;
              }
              if (handledAsAgentEvent) continue;
              // 不是真正的 Agent 事件 → 回落到下面的普通 SSE 解析，不吞行
            }
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

              if (data.choices && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
                if (delta.content !== undefined && delta.content !== null) aiContent += delta.content;
                scheduleUpdateUI();
              }
            } catch (e) {}
          }
        }

        if (!gotDone && buffer.trim() && buffer.trim().startsWith('data:') && !buffer.includes('[DONE]')) {
          try {
            const data = JSON.parse(buffer.slice(5).trim());
            if (data.choices && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.content) aiContent += delta.content;
            }
          } catch(e) {}
        }
      }

      // 主循环：深度思考时间越长越容易撞上边缘掐流/网络抖动，
      // 未收到 [DONE] 即视为异常中断，指数退避后自动重试。
      const MAX_AUTO_RETRY = 3;
      let attempt = 0;
      let streamError = null;
      while (true) {
        attempt++;
        streamError = null;
        try {
          await runOnce();
        } catch (e) {
          // 用户手动中止、口令问题：不重试，直接走统一错误处理
          if (e.name === 'AbortError' || e.name === 'AuthError') { setRetryNotice(null); throw e; }
          streamError = e;
        }
        if (gotDone) break;
        // v6.6.0 Agent 模式不自动重试：重跑会重复执行工具（重复搜索/重复记忆），中断直接走错误展示
        if (agentMode) break;
        if (!streamError) streamError = new Error('连接意外中断（未收到结束标记）');
        if (attempt > MAX_AUTO_RETRY) break;
        resetStreamUI();
        setRetryNotice('连接意外中断，正在自动重试（第 ' + attempt + ' 次）…');
        await new Promise(function (resolve) { setTimeout(resolve, 1200 * attempt); });
      }
      setRetryNotice(null);
      if (!gotDone) throw streamError;

      isCurrentlyStreaming = false;
      if (!reasoningContent && rBox) rBox.remove();
      clearAgentProgress();

      tBox.innerHTML = safeHtml(aiContent);
      tBox.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      scrollArea.scrollTop = scrollArea.scrollHeight;

      // 自动朗读（若已在左下角开启）
      if (autoSpeak && aiContent && aiContent.trim()) {
        const sb = bubble.querySelector('.speak-btn');
        if (sb) toggleSpeak(sb, bubble);
      }
      
      currentSession.messages.push({ role: 'assistant', content: aiContent }); 
      saveSessions();
      
    } catch (error) {
      isCurrentlyStreaming = false;
      clearAgentProgress();
      const tBox = bubble.querySelector('.message-text');

      if (error.name === 'AgentError') {
        // v6.6.0 Agent 执行错误：红色展示，不记入历史（避免错误文本污染上下文）
        tBox.innerHTML = '<span style="color: #ef4444; font-size: 14px; font-weight: 600;">' + escapeHtml(error.message) + '</span>';
        bubble.parentElement.classList.add('error-msg');
      } else if (error.name === 'AbortError') {
        const interruptNote = '<br><br><span style="color: var(--text-secondary); font-size: 13px; font-weight: 500;">(🛑 生成已手动中止)</span>';
        tBox.innerHTML = safeHtml(aiContent || '已中止') + interruptNote;
        if (aiContent) currentSession.messages.push({ role: 'assistant', content: aiContent });
      } else if (error.name === 'AuthError') {
        tBox.innerHTML = '<span style="color: var(--brand-color); font-size: 15px; font-weight: 600;">需要访问口令</span>' +
          '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 8px; line-height: 1.6;">请在左下角「设置」中填写与服务端 ACCESS_PASSWORD 一致的口令，保存后重新发送。</div>';
        bubble.parentElement.classList.add('error-msg');
        currentSession.messages.pop();
        userInput.value = text;
        userInput.dispatchEvent(new Event('input'));
      } else {
        if (aiContent || reasoningContent) {
          // 字符串拼接替换模板字符串，彻底规避 CF 编辑器转义 Bug
          tBox.innerHTML = safeHtml(aiContent) + '<br><br><span style="color: #ef4444; font-size: 13px; font-weight: 500;">(⚠️ 网络连接中断，已保留当前生成的内容。错误: ' + escapeHtml(error.message) + ')</span>';
          currentSession.messages.push({ role: 'assistant', content: aiContent });
          if (rBox && reasoningContent) rBox.remove(); 
        } else {
          tBox.innerText = '通信断开: ' + error.message; 
          bubble.parentElement.classList.add('error-msg');
          currentSession.messages.pop(); 
        }
      }
      tBox.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      saveSessions();
    } finally {
      isCurrentlyStreaming = false;
      currentAbortController = null;
      statusDot.classList.remove('generating'); 
      
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
      
      if (userInput.value.trim().length > 0) sendBtn.classList.add('active'); 
      userInput.focus();
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isCurrentlyStreaming && currentAbortController) {
      currentAbortController.abort(); 
    } else {
      sendMessage();
    }
  });

  userInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); 
      if (sendBtn.classList.contains('active') && !isCurrentlyStreaming) { 
        sendMessage(); 
      }
    } 
  });
  
  const settingsModal = document.getElementById('settingsModal');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const defaultModelSetting = document.getElementById('defaultModelSetting');
  const accessTokenSetting = document.getElementById('accessTokenSetting');

  if (defaultModelSetting) {
    defaultModelSetting.value = localStorage.getItem('default_model') || (modelSelect.options.length > 0 ? modelSelect.options[0].value : "");
  }
  if (accessTokenSetting) {
    accessTokenSetting.value = accessToken;
  }

  function openSettings() {
    settingsModal.style.display = 'flex';
    setTimeout(() => settingsModal.classList.add('active'), 10);
  }

  settingsToggle.addEventListener('click', openSettings);

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    if (defaultModelSetting.value) {
      localStorage.setItem('default_model', defaultModelSetting.value);
    }
    if (accessTokenSetting) {
      accessToken = accessTokenSetting.value.trim();
      if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      else localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    setTimeout(() => settingsModal.style.display = 'none', 300);
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsBtn.click();
  });

  document.getElementById('newChatBtn').addEventListener('click', createNewSession);

  // 左下角「自动朗读」开关
  const ttsToggleBtn = document.getElementById('ttsToggle');
  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', () => {
      autoSpeak = !autoSpeak;
      localStorage.setItem(TTS_AUTO_KEY, autoSpeak ? '1' : '0');
      if (!autoSpeak) stopSpeaking();
      updateTtsToggleUI();
    });
  }
  updateTtsToggleUI();

  // 页面关闭 / 切换标签页时停止朗读
  window.addEventListener('beforeunload', stopSpeaking);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeaking(); });

  // ================= PWA =================

  // 1) 注册 Service Worker（挂在根路径，scope 覆盖整站）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // 2) 离线检测 + 自动重连
  //    不依赖 navigator.onLine —— 它只反映网卡状态，判断不了「服务端是否可达」。
  //    改为轮询 /healthz；该路径在 Service Worker 中被显式放行且绝不缓存，
  //    否则探针会被缓存应答，永远「探测成功」，自动重连形同虚设。
  const offlineBanner = document.getElementById('offlineBanner');
  const offlineText = document.getElementById('offlineText');
  let offlineState = false;

  function setOffline(on, reason) {
    if (on === offlineState) return;
    offlineState = on;
    if (offlineBanner) offlineBanner.classList.toggle('show', on);
    if (on && offlineText && reason) offlineText.textContent = reason;
  }

  async function checkHealth() {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (!res.ok) throw new Error('unhealthy');
      if (offlineState) {
        setOffline(false);
        // 刚恢复：重绘当前会话，清掉离线期间残留的错误气泡
        if (!isCurrentlyStreaming) renderMessages();
      }
    } catch (e) {
      setOffline(true, '网络已断开，正在尝试重连…');
    }
  }

  window.addEventListener('online', checkHealth);
  window.addEventListener('offline', () => setOffline(true, '网络已断开，正在尝试重连…'));
  setInterval(checkHealth, 8000);
  checkHealth();

  // 3) 安装到桌面 / 主屏幕
  let deferredInstallPrompt = null;
  const installBtn = document.getElementById('installBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (e) {}
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtn) installBtn.hidden = true;
  });

  // 已经以独立窗口方式运行时不再显示安装按钮
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    if (installBtn) installBtn.hidden = true;
  }

  init();

  // 4) 支持 manifest 快捷方式 /?new=1 —— 直接开一个新会话
  try {
    if (new URLSearchParams(location.search).get('new') === '1' && sessions.length > 0) {
      createNewSession();
    }
  } catch (e) {}

</script>
</body>
</html>`;
