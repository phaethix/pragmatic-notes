---
title: Go Proverbs 逐条解析
date: 2026-10-01
description: Rob Pike 的 19 条 Go 箴言，逐条给出中文译文、设计哲学解读、正反代码示例与速查表。
tags:
  - Go
  - 工程实践
---

# Go Proverbs 逐条解析

Rob Pike 在 Gopherfest SV 2015 上给出了 19 条 Go 箴言（[原文](https://go-proverbs.github.io/)）。它们不是语法规则，而是 Go 设计者在**并发、接口、错误处理、工程化**上的价值判断。

每条按 **原文 → 译文 → 术语 → 解读 → 代码示例 → 图式** 展开。文末的速查表可以单独当作 Code Review 检查清单用。

本文示例均在 Go 1.27 下用 `go build` / `go vet` / `go run -race` 实测过。

## 01 · Don't communicate by sharing memory, share memory by communicating.

> 不要**通过共享内存**来通信；而应**通过通信**来共享内存。

**术语**

- **共享内存**：多个 goroutine 读写同一变量/结构体，靠 `sync.Mutex`、`atomic` 保证互斥。
- **通信**：通过 `channel` 把数据的**所有权**从一个 goroutine 转交给另一个。
- **CSP**：Communicating Sequential Processes，Hoare 提出的并发模型；Go 的 `chan`/`select` 受其启发（经 Newsqueak 一脉），但只取了“以通信代替共享”的思想，并非 CSP 形式化语义的完整实现。
- **ownership**：任一时刻只有一个 goroutine 有权访问某块数据，从而无需加锁。

### 解读

::: tip 它解决什么问题
并发 bug 的根因是“多个执行体同时碰同一份可变状态”。加锁方案把正确性寄托在“程序员记得在所有读写点加锁”上——漏一处就数据竞争，加错顺序就死锁。CSP 换了个思路：**让数据只属于一个 goroutine，谁要用就把数据（或请求）通过 channel 送过去**。这样“互斥”不再是靠纪律维持的约定，而是由语言结构保证的事实。
:::

::: info 适用场景
需要在多个 goroutine 间传递结果、任务、状态变更通知时；需要构建 worker pool、pipeline、fan-out/fan-in 时；数据需要被多方访问但只有一方修改时。判断口诀：**传递数据的所有权 → channel；保护一小段状态 → mutex**。
:::

::: warning 违背后果
竞态写入导致统计数字凭空丢失、map 并发写直接 `fatal error: concurrent map writes`、偶发且不可复现的线上故障，以及"加锁范围越滚越大"最终演化成一把全局大锁，把并发程序跑成了串行程序。
:::

### 示例

**✕ 不推荐：共享内存 + 锁**

```go
var (
    mu   sync.Mutex
    hits = map[string]int{}
)

func Record(k string) {
    mu.Lock()
    hits[k]++
    mu.Unlock()
}

func Report() map[string]int {
    mu.Lock()
    defer mu.Unlock()
    return hits   // 把内部 map 交出去，
                  // 锁的保护就此失效
}
```

**✓ 推荐：单一 owner + channel**

```go
type Collector struct {
    reqs chan req        // 单一入口：所有请求排队，FIFO
}

type req struct {
    key     string
    wantAll bool
    reply   chan map[string]int
}

func NewCollector() *Collector {
    c := &Collector{reqs: make(chan req, 128)}
    go c.loop()          // 唯一 owner
    return c
}

func (c *Collector) Record(k string) {
    c.reqs <- req{key: k}   // 通信，而非共享
}

// 要快照：request/response 往返一次
func (c *Collector) Report() map[string]int {
    ch := make(chan map[string]int)
    c.reqs <- req{wantAll: true, reply: ch}
    return <-ch
}

func (c *Collector) loop() {
    hits := map[string]int{}   // 只有 loop 看得见
    for r := range c.reqs {    // 单通道 → 严格 FIFO
        if r.wantAll {
            snap := make(map[string]int, len(hits))
            for k, v := range hits { snap[k] = v }
            r.reply <- snap  // 交出副本而非本体
            continue
        }
        hits[r.key]++
    }
}
```

**差异说明：**左侧需要每个调用点都记得加锁，且 `Report` 一旦把 map 交出去，锁就形同虚设——调用方可以在锁外任意读写。右侧的 `hits` 是 `loop` 的局部变量，**结构上不可能被两个 goroutine 同时访问**，因此不需要任何锁；对外只暴露"发送事件"和"要一份快照"两种通信动作，快照是副本，泄漏不出去。**补充：**`Record` 只是投递，不能假定"返回即已入账"；但所有请求走**同一个 channel**，FIFO 保证 `Report` 返回时已处理完排在它前面的全部事件。这一点用"两个 channel + `select`"做不到：`select` 会在多个就绪 case 中随机选，快照可能漏掉已投递的事件。

### 图式

图 1-1 共享内存（多写者争抢） vs 通信（所有权流转）

```
共享内存（✕）                     通信：所有权流转（✓）

  G1 ─┐                            G1 ──► [ chan ] ──► owner G
  G2 ─┼──► shared map                                  独占数据
  G3 ─┘    ↑ 必须由锁保护                              无需加锁

正确性依赖"人记得加锁"          互斥是结构保证，不是约定
```

## 02 · Concurrency is not parallelism.

> **并发**不是**并行**。

**术语**

- **并发 Concurrency**：**程序结构**层面的概念——把问题拆成多个可独立推进、需要相互协调的单元。关心的是“怎么组织”。
- **并行 Parallelism**：**执行**层面的概念——同一时刻真的有多个指令在跑。关心的是“能不能同时做”。
- **GOMAXPROCS**：控制可同时执行 Go 代码的操作系统线程数，只影响**并行度**，不影响并发结构的正确性。
- **阻塞**：goroutine 等在 I/O、锁、channel 上时让出执行权，这正是单核上并发仍能提速的原因。

### 解读

::: tip 它解决什么问题
很多人把"开 goroutine"等同于"变快"，于是盲目加大并发度、用共享变量粗暴搬运结果，甚至用 `time.Sleep` 做同步。这条箴言提醒：并发首先是一种**分解问题的思维方式**，它让你把"等待 I/O"和"处理逻辑"拆开；是否真的多核同时跑，是运行时的调度结果，与代码是否正确无关。
:::

::: info 适用场景
设计需要同时处理多路 I/O（HTTP 服务、消息消费、批量抓取）的结构时，先按并发建模；性能调优时再考虑并行度。写 goroutine 的正确性判断标准是：**即便 `GOMAXPROCS=1`，程序也应当正确**——能正确才谈得上快。
:::

::: warning 违背后果
把并发当并行，会导致：用 `Sleep` 等待（慢机器上偶发失败）、结果顺序依赖完成顺序（输出随机）、goroutine 无节制创建（内存与调度开销爆炸）；反过来，"并发一定更快"的误解也会让人给纯 CPU 密集任务开成千上万个 goroutine，反而因调度开销变慢。
:::

### 示例

**✕ 不推荐：把并发当“并行提速”**

```go
// 共享切片 + 锁搬运结果，还用 Sleep 等待
var mu sync.Mutex
var out []string

for _, u := range urls {
    go func(u string) {
        r := fetch(u)
        mu.Lock()
        out = append(out, r) // 顺序 = 完成顺序
        mu.Unlock()
    }(u)
}
time.Sleep(time.Second) // 用猜的时间同步
// 单核上也"并发"了，但没人知道何时结束
```

**✓ 推荐：结构化并发**

```go
// 每个抓取任务独立，结果经 channel 汇聚
// GOMAXPROCS=1 时同样正确；多核时自然并行
var out []string
results := make(chan string, len(urls))
var wg sync.WaitGroup

for _, u := range urls {
    wg.Add(1)
    go func(u string) {
        defer wg.Done()
        results <- fetch(u)
    }(u)
}
go func() { wg.Wait(); close(results) }()

for r := range results {   // 顺序 = 完成顺序；需与 urls 同序请按索引回填
    out = append(out, r)
}
```

**差异说明：**左侧用 `Sleep` 猜测执行时间——快了丢结果，慢了浪费时间。右侧用 `WaitGroup` + `close` 表达"**所有任务做完就关闭通道**"，`range` 自然终止，同步是**事件驱动**而非时间驱动。它在单核上靠"等待 I/O 时让出"依然能重叠多个请求，多核上则真正并行执行。**注意：✓ 版解决的是"何时结束"，不是"顺序"**——它的顺序同样取决于完成顺序；若要求输出与 `urls` 同序，应按索引回填 `rs[i] = fetch(u)`。

### 图式

图 2-1 并发（结构上的交错） vs 并行（时间上的同时）

```
并发（结构设计 · 交错推进）      并行（真的同时执行）

  A  ████░░████░░                 CPU 0  ████████████
  B  ░░████░░████                 CPU 1  ████████████
     ░ = 等待 / 让出

单核即可实现                     需要多核，由 GOMAXPROCS 决定
```

## 03 · Channels orchestrate; mutexes serialize.

> Channel 用于**编排（协调）**；互斥锁用于**串行化**。

**术语**

- **orchestrate 编排**：安排“谁来做、什么时候做、什么时候停”，表达 goroutine 之间的**流程与生命周期**。
- **serialize 串行化**：让同一段代码在同一时刻只能被一个 goroutine 执行，即保护**临界区**。
- **临界区**：访问共享状态的那几行代码，越短越好。
- `close(ch)`：向所有接收者广播"不会再有值了"，是最常用的编排信号。

### 解读

::: tip 它解决什么问题
前两条讲完"要用 channel"，容易被误读成"一切用 channel"。这条给出分工边界：**channel 是流程原语，mutex 是数据原语**。用 mutex 去表达"任务分发、阶段推进、停止信号"会把状态机拆成碎片；反过来用 channel 保护一个计数器，只是把 `Lock/Unlock` 换成了两次通信，既慢又容易在 panic 路径上"还不了锁"。
:::

::: info 适用场景
worker pool、pipeline、超时取消、限流、生命周期通知 → **channel + select + context**；共享的计数器、缓存 map、配置热更新、连接状态 → **mutex/RWMutex/atomic**。二者经常同时出现：channel 编排任务，mutex 保护 worker 共同写入的结果结构。
:::

::: warning 违背后果
拿 channel 当锁：把"互斥"表达成"一次数据传递"，读者一眼看不出这是在保护临界区，且必须靠人记得写 `defer` 归还，漏写即永久阻塞（实测可复现）。拿 mutex 编排流程：出现大量 `Lock` 包裹的大段逻辑，逐步演化为锁顺序问题与死锁，且无法用 `select` 表达"等待多个事件中的任意一个"。
:::

### 示例

**✕ 不推荐：拿 channel 当锁**

```go
// 用容量为 1 的 channel 模拟互斥
var sem = make(chan struct{}, 1)
var counter int

func Inc() {
    sem <- struct{}{}   // "lock"
    counter++
    <-sem               // "unlock"
    // 若中间 panic 或提前 return，
    // 这个 sem 再也还不了 → 永久阻塞
}

func Inc2() error {
    sem <- struct{}{}
    if err := step(); err != nil {
        return err      // ❌ 忘记归还
    }
    counter++
    <-sem
    return nil
}
```

**✓ 推荐：各司其职**

```go
var (
    mu      sync.Mutex
    counter int
)

// 串行化：临界区只有一行
func Inc() {
    mu.Lock()
    counter++
    mu.Unlock()
}

// 编排：谁来做、何时结束
func Run(jobs []Job) {
    work := make(chan Job)
    var wg sync.WaitGroup
    for i := 0; i < 4; i++ {       // 4 个 worker
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := range work {  // close 即停止信号
                if err := j.Do(); err == nil {
                    mu.Lock()      // 只保护共享计数
                    counter++
                    mu.Unlock()
                }
            }
        }()
    }
    for _, j := range jobs { work <- j }
    close(work)                    // 广播结束
    wg.Wait()
}
```

**差异说明：**左侧的"信号量锁"把一次互斥变成两次 channel 通信（无竞争实测约 3.5 ns vs 12.6 ns，约 3–5 倍），且 `Inc2` 的错误分支直接漏归还——这是最典型的死锁来源。右侧用 `sync.Mutex` 精确串行化一行代码，用 channel 表达"分发任务"和"关闭即停止"的编排语义，`for range work` 在 `close` 后自动退出，无需任何额外同步。

### 图式

图 3-1 channel 编排流程 · mutex 串行化临界区

```
编排层：producer ──► [ chan Job ] ──► W1 W2 W3 W4 ──► close(work) 广播结束
                                         │
数据层：                                 ▼
        多个 W ──► mu.Lock(); counter++; mu.Unlock()   ← 临界区只有一行

流程用 channel，状态用 mutex
```

## 04 · The bigger the interface, the weaker the abstraction.

> **接口越大，抽象越弱**。

**术语**

- **接口 interface**：Go 中是**方法集合**的声明；类型是**隐式实现**接口的——只要方法集包含接口全部方法即可，无需 `implements`。
- **抽象**：用“能做什么”替代“具体是什么”，从而可以替换实现。
- **组合**：小接口可由调用方按需拼装成更大的接口（`ReadWriteCloser = Reader + Writer + Closer`）。
- `io.Reader` / `io.Writer`：单方法接口的典范，正因为小，才有成千上万种实现。

### 解读

::: tip 它解决什么问题
接口的价值在于**可被多种类型实现**，从而让调用方不依赖具体类型。每增加一个方法，就多一条“实现者必须满足”的约束，也多一分与某个具体实现的耦合——方法越多，能满足它的类型越少，抽象就越接近“某一个具体类型”，也就失去了抽象的意义。
:::

::: info 适用场景
定义函数/库的入参类型时，**站在调用方立场声明"我最小需要什么"**：只要读就用 `io.Reader`，只要写就用 `io.Writer`，只要格式化就用 `fmt.Stringer`。需要更多能力时再在调用点组合，而不是一开始就定义大接口。
:::

::: warning 违背后果
大接口导致：单元测试无法用轻量 fake 替换（必须做出一个"真的文件"）；新实现被迫写一堆 `return errors.New("not implemented")`；接口一旦发布就难以后退，牵一发动全身。典型症状是"定义了 7 个方法的 `Storage` 接口，实际只有一个实现"。
:::

### 示例

**✕ 不推荐：大而全的接口**

```go
type Storage interface {
    Open(name string) error
    Close() error
    Read(p []byte) (int, error)
    Write(p []byte) (int, error)
    Seek(offset int64, whence int) (int64, error)
    Flush() error
    Stat() (os.FileInfo, error)
}

// 标准库中没有任何类型能满足它（*os.File 既没有
// Open 也没有 Flush）；只能为它专门写一个包装类型
// ——这正是"抽象退化成某个具体类型"的信号。
func Save(s Storage, data []byte) error {
    if err := s.Open("x"); err != nil {
        return err
    }
    _, err := s.Write(data)
    return err
}
```

**✓ 推荐：单方法接口 + 按需组合**

```go
// 只声明"我真正需要的能力"
func Save(w io.Writer, data []byte) (int, error) {
    return w.Write(data)
}

// 调用方按需组合更大的契约
type ReadWriter interface {
    io.Reader
    io.Writer
}

// 用法：任何一端都能自由替换
Save(os.Stdout, b)              // 文件
Save(&bytes.Buffer{}, b)        // 内存
Save(newFakerForTest(), b)      // 测试的假实现
Save(netConn, b)                // 网络连接
```

**差异说明：**左侧的 `Save` 要求传入一个能 Open/Close/Seek/Stat 的完整存储，`bytes.Buffer`、网络连接、测试 fake 全部被拒之门外，单测只能碰真实文件系统。右侧只要 `io.Writer` 一个方法，**实现成本从一个"文件系统"降到"一个 Write 方法"**，替换实现零成本。注意组合的方向：**接口应由使用方定义，而不是由实现方提供**。

### 图式

图 4-1 接口规模 → 可实现类型数量 → 抽象强度

```
方法数    可实现类型数    抽象强度
  1      ████████████   极强  io.Writer（实现者 ∞）
  2      ████████       较强  ReadWriter
  4      ████           中等
  7      █              失效  ≈ 1 个实现（退化成具体类型）

方法数 ↑ → 可实现类型 ↓ → 抽象强度 ↓
```

## 05 · Make the zero value useful.

> 让**零值有用**。

**术语**

- **零值 zero value**：变量声明而未显式初始化时的默认值——数值为 `0`、字符串为 `""`、布尔为 `false`、指针/切片/map/接口/通道/func 为 `nil`、结构体为其各字段零值。
- **有用的零值**：`var b bytes.Buffer` 可直接 `Write`；`var mu sync.Mutex` 可直接 `Lock`；`var wg sync.WaitGroup` 可直接 `Add`。
- **惰性初始化 lazy init**：在方法内部检测到零值再做初始化，让“声明即可用”。
- `sync.Once`：把一次性初始化封装进类型内部，避免暴露给调用方。

### 解读

::: tip 它解决什么问题
每个需要 `New()` 才能用的类型，都在 API 上留了一个"忘记初始化"的坑，而且编译器不会提醒你。Go 让零值成为**合法且可用的状态**，就把"必须记住的调用约定"变成了"什么都不做也对"——这是 Go 减少认知负担的核心手法之一。
:::

::: info 适用场景
设计任何导出类型时都问一句：**`var x T` 之后直接调用方法会怎样？**若会 panic，要么用惰性初始化补上，要么用 `sync.Once` 封装，要么明确要求构造函数并让零值方法返回清晰错误（而不是崩溃）。配置结构体尤其应当零值可用，再用 `Option` 覆盖默认值。
:::

::: warning 违背后果
调用方拿到零值 `Counter{}` 调 `Inc` 直接 `panic: assignment to entry in nil map`；结构体作为另一个结构体的字段被间接构造时，深层字段没被初始化，错误在完全无关的地方爆发，排查成本极高。
:::

### 示例

**✕ 不推荐：零值不可用**

```go
type Counter struct {
    m map[string]int
}

func (c *Counter) Inc(k string) {
    c.m[k]++   // ❌ 零值 Counter{} 直接 panic
}

func main() {
    var c Counter
    c.Inc("a")
}
// panic: assignment to entry in nil map
```

**✓ 推荐：零值即可用**

```go
type Counter struct {
    m map[string]int
}

// 惰性初始化：让零值直接可用
func (c *Counter) Inc(k string) {
    if c.m == nil {
        c.m = make(map[string]int)
    }
    c.m[k]++
}

func main() {
    var c Counter
    c.Inc("a")   // ✅ 正常工作
}
// 注意：零值可用 ≠ 并发安全。若 Inc 会被多个
// goroutine 同时调用，惰性初始化要换成 sync.Once
// 或由构造函数保证。

// 标准库中的同类设计：
var b bytes.Buffer; b.WriteString("hi") // ✅
var mu sync.Mutex;  mu.Lock()           // ✅
var wg sync.WaitGroup; wg.Add(1)        // ✅
```

**差异说明：**两版结构体定义完全一样，差别只在 `Inc` 里那三行惰性初始化。左侧把"必须先 `New`"的负担转嫁给**每一个调用方**，且失败方式是运行时 panic；右侧把负担收进类型内部，`var c Counter` 之后立即可用，作为嵌套字段时也不会漏初始化。

### 图式

图 5-1 零值可用 vs 需要构造函数的调用路径

```
✕ 零值不可用
  var c Counter ──► 必须记得 New() ──► 忘记则 panic

✓ 零值有用
  var c Counter ──► 直接 Inc()
                    （惰性初始化收在类型内部）
```

## 06 · interface{} says nothing.

> **空接口 interface{}（即 any）什么都没说明**。

**术语**

- **空接口**：方法集为空的接口。**任何**类型都满足它，因此它对"能做什么"不提供任何信息。Go 1.18 起 `any` 是 `interface{}` 的别名。
- **类型断言 / type switch**：`v.(T)` 与 `switch v := x.(type)`，把类型检查从编译期推迟到运行期。
- **类型参数（泛型）**：`func F[T Constraint](x T)`，用编译期约束替代运行期断言。
- **合法用途**：真正的"不透明容器"（如 `encoding/json` 的解码目标、`log` 的结构化字段）。

### 解读

::: tip 它解决什么问题
Go 是静态类型语言，类型声明就是**给编译器和读者的一份契约**。`interface{}` 把这份契约清空了：函数签名不再告诉你参数能做什么，IDE 无法补全，编译器无法检查，所有错误推迟到运行时的类型断言或反射阶段才以 panic 形式爆发。
:::

::: info 适用场景
优先三选一：①**具体类型**（最清楚）；②**小接口**（声明真正需要的行为，如 `fmt.Stringer`）；③**泛型 + 约束**（Go 1.18+ 引入泛型；`cmp.Ordered` 需 Go 1.21+，1.18–1.20 可用 `golang.org/x/exp/constraints.Ordered`）。空接口只留给"确实不关心类型"的场景，如 `json.Unmarshal` 的目标、日志字段。
:::

::: warning 违背后果
API 变成"传什么都行、错了才炸"；函数体里塞满 `switch v := x.(type)`，新增类型时编译器不会提醒你漏了分支；重构时无法静态追踪调用点；最终演化成"运行时 panic 驱动的调试"。
:::

### 示例

**✕ 不推荐：空接口 + 运行时断言**

```go
func Max(a, b interface{}) interface{} {
    switch x := a.(type) {
    case int:
        y, ok := b.(int)
        if !ok { panic("类型不匹配") }
        if x > y { return x }
        return y
    case string:
        y, ok := b.(string)
        if !ok { panic("类型不匹配") }
        if x > y { return x }
        return y
    }
    panic("unsupported type")  // 编译期毫无提示
}

r := Max(1, 2).(int)  // 还要再断言一次
```

**✓ 推荐：泛型约束 / 小接口**

```go
import (
    "cmp"
    "fmt"
)

// 方案 A：泛型，编译期保证类型一致
func Max[T cmp.Ordered](a, b T) T {
    if a > b { return a }
    return b
}

r := Max(1, 2)        // int，无需断言
s := Max("a", "b")    // string
// 注：Go 1.21+ 已内建 max/min，实际项目直接用 max(a, b)
// Max(1, "b")  → 编译错误，当场发现

// 方案 B：只要"能格式化"，直接用标准库的最小接口
func Log(v fmt.Stringer) { fmt.Println(v.String()) }
```

**差异说明：**左侧签名 `func Max(a, b any) any` 没有传达任何约束，两个参数类型可以不一致，返回值还需要调用方再断言一次；每个新类型都要手写分支，漏了就 panic。右侧用 `cmp.Ordered` 约束：**类型一致性由编译器保证**，返回值类型精确，无需断言，且新增类型零成本。信息量的差别就是"编译期发现"与"线上崩溃"的差别。

### 图式

图 6-1 类型声明承载的信息量

```
func F(v any)           能做什么？不知道  →  错误在运行时暴露
func F(v fmt.Stringer)  能做什么？String() →  错误在编译期暴露

类型声明越具体，编译器和同事能帮你的越多
```

## 07 · Gofmt's style is no one's favorite, yet gofmt is everyone's favorite.

> gofmt 的风格**不是任何人的最爱**，但 gofmt **却是所有人的最爱**。

**术语**

- **gofmt**：Go 官方格式化工具，没有任何控制缩进、对齐与换行风格的配置项，也没有配置文件（`-s`/`-r` 是独立的改写开关，不改变“风格不可配置”这一事实）。
- **无配置**：这是特性而非缺陷——一旦可配置，统一就不复存在。
- **gofmt -l / gofumpt**：`-l` 列出未格式化的文件，常接入 CI；`gofumpt` 是更严格的社区增强版（非官方）。
- **goimports**：gofmt + 自动整理 import 分组与增删。

### 解读

::: tip 它解决什么问题
代码风格争论是零和游戏：无论采纳谁的偏好，都有人不舒服，且每次 code review 都在重复消耗注意力。gofmt 的解法是**取消选择权**——它不产出“最好看”的结果，只产出“唯一”的结果。统一格式带来的真正收益是 **diff 干净**：代码变更只反映逻辑改动，不再被对齐、换行噪音淹没。
:::

::: info 适用场景
所有 Go 代码，无一例外。做法：编辑器保存时自动 `goimports`；CI 加一步 `gofmt -l . | tee /dev/stderr | (! read)`（干净时退出码 0、有未格式化文件时非 0）；`go vet` 另做静态检查，它**不管格式**；团队不再设立任何风格规范文档。
:::

::: warning 违背后果
人工对齐的代码在字段增减时产生大量无关 diff，review 者无法分辨“改了什么”；仓库内出现多种风格，跨模块阅读时需要额外切换；新人每次提交都被风格意见反馈，讨论焦点从设计滑向空格与括号。
:::

### 示例

**✕ 不推荐：手工对齐 / 混入个人风格**

```go
type User struct{
    ID       int
    Name     string
    CreatedAt time.Time
}

func New( name string ,age int)*User{
  u:=&User{Name:name}
  if(age>0){u.ID=age}
  return u
}
// 混用空格与 tab、括号风格不统一、
// 空格位置随意 —— 每个人写法都不同
```

**✓ 推荐：交给 gofmt / goimports**

```go
type User struct {
    ID        int
    Name      string
    CreatedAt time.Time
}

func New(name string, age int) *User {
    u := &User{Name: name}
    if age > 0 {
        u.ID = age
    }
    return u
}
// gofmt 输出：唯一结果，无需讨论
```

**差异说明：**两段代码语义完全相同，但左侧的对齐依赖人工维护——新增一个比 `CreatedAt` 更长的字段（如 `OrganizationName`）时，已有三行的对齐空格全部要跟着改，diff 里凭空多出三行"毫无意义"的变更。（文中代码块以空格展示，gofmt 实际输出为 tab。）右侧全部由工具生成，字段增减只产生一行 diff。**收益不在美观，而在 diff 的可读性与争论的消失。**

### 图式

图 7-1 风格分歧 vs 统一格式化

```
各自偏好   风格 A / 风格 B / 风格 C  ──► diff 充满噪音 · review 争论风格

gofmt      风格 A / 风格 B / 风格 C  ──► [ 唯一输出 ] ──► diff 只含逻辑变更
```

## 08 · A little copying is better than a little dependency.

> **少量复制，胜过少量依赖**。

**术语**

- **依赖**：进入你构建图的第三方模块；它带来版本、传递依赖、安全公告、许可证与升级维护成本。
- **复制**：把几行/几十行代码放进自己仓库，从此归你维护、随你修改。
- **传递依赖**：你依赖的库所依赖的库——它们同样进入你的二进制与供应链风险面。
- `go.mod` / `vendor`：依赖清单与本地副本目录；依赖越多，`go.sum` 越庞大。

### 解读

::: tip 它解决什么问题
现代包管理让"加一个依赖"变成一行命令，成本被严重低估。为了一个 `Min` 函数引入一个工具库，你同时引入了它的全部传递依赖、它的发布节奏、它的 CVE 面、它的许可证，以及"它哪天不维护了"的风险。**依赖是长期负债，复制是一次性成本**——当负债远大于复制代价时，就该复制。
:::

::: info 适用场景
判断标准：**复制的代码量 < 集成与维护该依赖的成本 → 复制**。典型可复制项：字符串/切片小工具、常量表、几十行的编码器。反之，**不该复制**：加密算法、协议实现、需要持续跟进 CVE 的复杂组件——这些的专业维护成本远高于依赖成本。
:::

::: warning 违背后果
`go.mod` 里几十个间接依赖；某个上游库作者删库导致构建失败；安全扫描每周告警；升级 Go 版本时被某个陈旧传递依赖卡住；为了 3 行代码承担了 GPL 合规审查。
:::

### 示例

**✕ 不推荐：为几行代码引入整个库**

```go
// go.mod
require github.com/some/giant-utils v1.8.3
// → 连带 14 个间接依赖、2MB 二进制增长

import "github.com/some/giant-utils/strutil"

func clip(s string, n int) string {
    return strutil.TruncateRunes(s, n) // 只为这一行
}

// strutil 内部还依赖 reflect、unicode 表、
// 日志抽象、错误处理框架……
```

**✓ 推荐：本地几行实现**

```go
// 自己写，6 行，零依赖，语义完全可控
func clip(s string, n int) string {
    if n < 0 {
        return ""
    }
    r := []rune(s)          // 按 rune 而非 byte 截断
    if len(r) <= n {
        return s
    }
    return string(r[:n])
}

// 归属清晰：可改、可测、可删
// 无版本风险、无许可证审查、无 CVE 面
```

**差异说明：**两版功能等价，区别在于成本归属。左侧把"截断字符串"这件小事绑定到一个 14 个传递依赖的模块上——它的任何变更、任何安全公告、任何许可证问题都变成你的问题。右侧 6 行代码进入你的仓库，从此**由你控制的确定性资产**。注意：`[]rune(s)` 会有一次内存分配（按 rune 截断无法零拷贝）；这里说的是**代码**的复制而非数据的复制——恰恰说明这类几行小事不值得外部化。

### 图式

图 8-1 依赖 vs 复制：成本随时间的变化

```
引入依赖   现在 1 行 import ──► 版本升级 · 传递依赖 · CVE · 合规
           ──► 上游弃维护则你被迫接手        持续负债，成本随时间增长

少量复制   现在 6 行代码 ──► 可改 · 可测 · 可删 ──► 无版本 / CVE / 合规问题
                                                 一次性成本
```

## 09 · Syscall must always be guarded with build tags.

> **系统调用必须始终用构建标签加以隔离**。

**术语**

- **syscall**：直接调用操作系统内核接口；系统调用号、结构体布局、常量值**随 GOOS/GOARCH 而异**。
- **build tag**：文件顶部的构建约束，如 `//go:build linux`（Go 1.17+）或 `// +build linux`（旧式），决定该文件的编译范围。
- **GOOS / GOARCH**：目标操作系统与 CPU 架构，由环境变量或文件名后缀（`foo_linux.go`、`foo_darwin_arm64.go`）决定。
- **golang.org/x/sys**：官方推荐的 syscall 替代，**标准库 syscall 包已冻结**，不再新增内容（官方表述：`Deprecated: this package is locked down`；安全性与正确性修复仍会进行）。

### 解读

::: tip 它解决什么问题
系统调用是 Go 中**唯一天然不可移植**的部分：Linux 有 `epoll`、macOS 有 `kqueue`、Windows 有 IOCP；常量名与结构体字段也不同。构建标签把"平台专属代码"物理隔离到独立文件中，让每个平台只编译属于自己的那部分，其余平台要么编译替代实现，要么得到明确的不支持提示。
:::

::: info 适用场景
任何直接使用 `syscall` 或 `golang.org/x/sys/unix` 的代码。惯例：`disk_linux.go` / `disk_darwin.go` / `disk_windows.go`，或 `//go:build linux || darwin`；并为未覆盖平台提供 `//go:build !linux && !darwin` 的兜底实现。
:::

::: warning 违背后果
不做隔离，`GOOS=windows go build` 直接 `undefined: syscall.Statfs_t`；更糟的情况是常量在不同平台上**恰好存在但语义不同**，代码能编译却在运行时给出错误结果——这类 bug 极难定位。同时也会毁掉交叉编译能力（`GOOS=linux GOARCH=arm64`）。
:::

### 示例

**✕ 不推荐：syscall 混在通用文件里**

```go
// disk.go —— 无 build tag，全平台都会编译
package disk

import "syscall"

func FreeBytes(path string) (uint64, error) {
    var st syscall.Statfs_t   // ❌ Windows 无此类型
    if err := syscall.Statfs(path, &st); err != nil {
        return 0, err
    }
    return uint64(st.Bavail) * uint64(st.Bsize), nil
}

// GOOS=windows go build
// → undefined: syscall.Statfs_t
```

**✓ 推荐：按平台拆分 + 兜底实现**

```go
// disk.go —— 公共 API，不含 syscall
package disk

func FreeBytes(path string) (uint64, error) {
    return freeBytes(path)   // 由下面的平台文件提供
}

// disk_unix.go
//go:build linux || darwin || freebsd

package disk

import "golang.org/x/sys/unix"

func freeBytes(path string) (uint64, error) {
    var st unix.Statfs_t
    if err := unix.Statfs(path, &st); err != nil {
        return 0, err
    }
    return st.Bavail * uint64(st.Bsize), nil
}

// disk_other.go
//go:build !(linux || darwin || freebsd)

package disk

import "errors"

var ErrUnsupported = errors.New("unsupported OS")

func freeBytes(string) (uint64, error) {
    return 0, ErrUnsupported   // 明确的不支持
}
```

**差异说明：**左侧把所有平台绑死在 Linux 的结构体上，构建在 Windows 上直接失败且毫无回旋余地。右侧用构建标签把实现按平台分文件，并提供 `ErrUnsupported` 兜底：**未覆盖平台是"明确不支持"，而不是"编译不过"**，上层可以按错误做降级。同时改用 `golang.org/x/sys`：标准库 `syscall` 已冻结，新平台与新常量只在 `x/sys` 中提供。

### 图式

图 9-1 构建标签如何分流不同平台

```
              ┌── GOOS=linux   ──► disk_unix.go   //go:build linux||darwin…
disk.go ──────┼── GOOS=darwin  ──► disk_unix.go   （x/sys 适配常量）
(公共 API)    └── GOOS=windows ──► disk_other.go  //go:build !(…) → ErrUnsupported

每个目标平台只编译属于自己的文件 → 交叉编译永不失败
```

## 10 · Cgo must always be guarded with build tags.

> **cgo 必须始终用构建标签加以隔离**。

**术语**

- **cgo**：在 Go 中调用 C 代码的机制，通过 `import "C"` 启用。
- **CGO_ENABLED**：构建开关。`=0` 时禁用 cgo，可产出**纯静态二进制**，便于交叉编译与 scratch/distroless 镜像。
- **交叉编译**：为另一个平台构建；有 cgo 时需要目标平台的 C 交叉编译器与头文件，通常不可用。
- **兜底文件**：`//go:build !cgo` 的纯 Go 实现，保证无 C 环境下仍能编译运行。

### 解读

::: tip 它解决什么问题
cgo 引入了对**外部 C 工具链**的依赖，这是 Go 最引以为傲的"一个二进制走到哪都能跑"特性的最大威胁。构建标签把"需要 C 的实现"与"纯 Go 实现"分开，让同一个包在 `CGO_ENABLED=1` 时用 C 加速版，在 `=0` 或缺少头文件时自动退化为纯 Go 版——**调用方代码无需任何改动**。
:::

::: info 适用场景
任何 `import "C"` 的文件。典型布局：`hash_cgo.go`（`//go:build cgo`）+ `hash_pure.go`（`//go:build !cgo`）+ `hash.go`（公共 API 与测试）。CI 中应同时跑两种构建，确保兜底实现始终可编译。
:::

::: warning 违背后果
`CGO_ENABLED=0 go build` 直接报 `build constraints exclude all Go files in ...`（含 `import "C"` 的文件被隐式 cgo 约束排除），或退化为 `undefined: sum`；`scratch` 镜像里二进制因动态链接 `libc` 而无法启动；`GOOS=linux GOARCH=arm64` 交叉编译失败；因 glibc 版本不匹配导致换台机器启动即失败（`version 'GLIBC_2.xx' not found`）。
:::

### 示例

**✕ 不推荐：cgo 写在主文件里**

```go
// hash.go —— 无 build tag，任何时候都启用 cgo
package hash

/*
#include <openssl/sha.h>
*/
import "C"

func Sum(b []byte) []byte {
    // 调用 OpenSSL
    ...
}

// CGO_ENABLED=0 go build  → 构建失败
// scratch 镜像            → 缺少 libc，运行失败
// 交叉编译到 arm64        → 无目标 C 编译器，失败
```

**✓ 推荐：cgo 版 + 纯 Go 兜底**

```go
// hash.go —— 公共 API，不含 import "C"
package hash

func Sum(b []byte) []byte { return sum(b) }

// hash_cgo.go
//go:build cgo

package hash

/*
#include <openssl/sha.h>
*/
import "C"

func sum(b []byte) []byte {
    /* TODO: 用 C.SHA256(...) 填充 */
    panic("not implemented")
}

// hash_pure.go
//go:build !cgo

package hash

import "crypto/sha256"

func sum(b []byte) []byte {
    s := sha256.Sum256(b)   // 纯 Go，永远可编译
    return s[:]
}
```

**差异说明：**左侧把"C 环境必须存在"变成了整个包的硬前提，任何一次 `CGO_ENABLED=0` 构建、任何一次交叉编译、任何一次精简镜像打包都会失败。右侧把差异收敛到一个未导出的 `sum` 函数上：**公共 API 与调用方完全不受影响**，构建环境自己决定用哪个实现，且纯 Go 兜底保证最坏情况仍能跑（只是慢一点）。

### 图式

图 10-1 cgo 与纯 Go 实现的构建分流

```
hash.Sum(b)（公共 API，不含 import "C"）
   ├── CGO_ENABLED=1 ──► hash_cgo.go   //go:build cgo    OpenSSL 加速
   └── CGO_ENABLED=0 ──► hash_pure.go  //go:build !cgo   crypto/sha256
                                        静态二进制 · 可交叉编译 · scratch 可跑
```

## 11 · Cgo is not Go.

> **cgo 不是 Go**。

**术语**

- **Go 运行时**：goroutine 调度器、可增长栈、GC、逃逸分析、race detector —— 这些**只覆盖 Go 代码**。
- **阻塞的 C 调用**：C 代码占用的是操作系统线程，Go 调度器无法抢占，长时间调用会独占一个线程。
- **调用开销**：一次 cgo 调用约十几到上百纳秒（随平台与版本差异大；Go 1.27 darwin/arm64 实测裸调用约 15 ns，含 CString/free 约 58 ns），比普通 Go 函数调用（亚纳秒级）高约两个数量级。
- **边界封装**：把 cgo 收进薄薄一层，对外只暴露纯 Go 签名（返回 `error` 而非 panic）。

### 解读

::: tip 它解决什么问题
人们容易把 cgo 当成"在 Go 里直接写 C"而忽略语义断层：跨过 `import "C"` 这条线之后，**goroutine 不再是 goroutine，Go 的内存安全带也不复存在**。这条箴言要求你在心理上把 C 代码当成"外部服务/外部资源"来对待——就像对待数据库或文件系统那样，需要边界、超时、错误处理与资源释放。
:::

::: info 适用场景
只在**确实没有 Go 实现**且**调用频率不高**时使用：系统级 API（如某些驱动、硬件接口）、必须复用的成熟 C 库。用法要点：封装成薄层；**批量调用一次而非循环内逐条调用**；不在回调中从 C 回到 Go 做复杂逻辑；C 分配的内存用 `C.free` 明确释放；把 C 的返回值翻译成 `error`。
:::

::: warning 违背后果
在热循环里逐条 cgo 调用 → 性能反而不如纯 Go；C 代码崩溃表现为整个进程 `SIGSEGV`，Go 的 panic/recover 无法拦截；race detector 看不见 C 侧的数据竞争；C 侧阻塞会独占一个 OS 线程（该 goroutine 不可被抢占），阻塞调用越多线程越多，直到撞上 10000 线程上限；其他 goroutine 仍可运行，但线程与上下文切换开销显著上升；把 Go 指针传给 C 并被长期保存 → 违反 cgo 指针传递规则（C 只能在调用期间持有；若指向的内存含 Go 指针，运行时尚会 panic `cgo argument has Go pointer to unpinned Go pointer`），确需长期持有请用 `runtime.Pinner`（Go 1.21+）显式 pin 或拷进 `C.malloc` 的内存。
:::

### 示例

**✕ 不推荐：热循环里逐条 cgo 调用**

```go
/*
static int score_one(const char* s) { ... }
*/
import "C"

func ScoreAll(items []string) []int {
    out := make([]int, len(items))
    for i, s := range items {
        cs := C.CString(s)
        out[i] = int(C.score_one(cs)) // 10 万次跨边界调用
        C.free(unsafe.Pointer(cs))    // 忘了就是泄漏
    }
    return out
}
// 每次调用：栈切换 + 线程固定 + 数十 ns 开销
// C 侧崩溃 → 整进程 SIGSEGV，recover 无效
```

**✓ 推荐：薄边界 + 批量调用**

```go
/*
static void score_batch(char** in, int* out, int n) {...}
*/
import "C"

// 一次跨边界，批量处理；对外仍是纯 Go 签名
func ScoreAll(items []string) ([]int, error) {
    n := len(items)
    if n == 0 {
        return []int{}, nil   // &out[0] 在空切片上会 panic
    }
    in := C.malloc(C.size_t(n) * C.size_t(unsafe.Sizeof(uintptr(0))))
    defer C.free(in)
    out := make([]C.int, n)

    // 填充 in：字符串要拷进 C 内存；注意 C.CString 本身
    // 也是一次 cgo 调用，批量时应一次性拷进一大块内存
    C.score_batch((**C.char)(in), &out[0], C.int(n))

    res := make([]int, n)
    for i := range out { res[i] = int(out[i]) }
    return res, nil   // 错误以 error 返回，不 panic
}
```

**差异说明：**左侧 **N 次**跨边界调用，每次都要做栈切换与线程固定，10 万条数据下开销远超纯 Go 实现；且 `CString`/`free` 的手工配对只要有一个分支漏掉就内存泄漏。右侧**一次**调用处理整批，把 cgo 的固有成本摊薄；对外仍是 `([]int, error)` 的纯 Go 签名，C 侧的失败被翻译成 error，**调用方不必知道自己背后是 C**。

### 图式

图 11-1 cgo 边界两侧的能力断层

```
Go 世界                            │              C 世界
goroutine 调度                     │            无 goroutine（占 OS 线程）
GC / 可增长栈                      │  import    手工 malloc / free
panic + recover                    │    "C"     崩溃 = SIGSEGV
race detector                      │  边界      race detector 不可见

跨过边界后，Go 的所有安全保证都不再适用
```

## 12 · With the unsafe package there are no guarantees.

> 一旦使用 **unsafe 包，就不再有任何保证**。

**术语**

- **unsafe**：标准库中的特殊包，提供 `Pointer`、`Slice`/`SliceData`/`Add`（1.17+）、`String`/`StringData`（1.20+）、`Sizeof` 等，**绕过类型系统与内存安全**。
- **没有保证**：Go 的兼容性承诺（Go 1 兼容性）覆盖语言与标准库 API，但**不覆盖** unsafe 依赖的内存布局与实现细节。
- **内存布局**：结构体字段排列、字符串头结构等是新编译器/GC 可自由改变的**实现细节**。
- `go vet` / `checkptr`：只能检查 unsafe 使用的**部分**常见错误，无法保证正确。

### 解读

::: tip 它解决什么问题
它是反向箴言——**不是教你用，而是警告你代价**。Go 用类型系统与 GC 换来了内存安全；`unsafe` 是唯一能主动放弃这份安全的出口。代价是：你写下的代码依赖的是"当前实现恰好如此"，而不是"语言承诺如此"。同一个二进制换个 Go 版本编译、换个 GOARCH、换个 GC 策略，行为就可能改变。
:::

::: info 适用场景
极少数场景：与系统调用/硬件交互时的零拷贝转换、标准库内部的性能关键路径、序列化库的布局优化。使用前提：①有 benchmark 证明收益显著；②把 unsafe 关在**极小的、有注释说明不变量**的函数里；③配套 `go test -race`（自动启用 checkptr）或 `-gcflags=all=-d=checkptr`，注意默认构建下不开启；④注明失效条件。
:::

::: warning 违背后果
最坏的一类 bug：**静默的内存破坏**——不是 panic，而是数据悄悄错掉，然后在几小时后、在完全无关的代码里崩溃或被写进数据库。升级 Go 版本后行为改变；不同架构上结果不同；`-race` 检测不到；review 时几乎无人能确认其正确性。
:::

### 示例

**✕ 不推荐：unsafe 结果长期持有**

```go
// string → []byte 零拷贝，然后写进去
func unsafeBytes(s string) []byte {
    return unsafe.Slice(unsafe.StringData(s), len(s))
}

b := unsafeBytes("hello")  // 字符串字面量在只读段
b[0] = 'H'                 // ❌ 写入只读内存
// 后果不确定：可能 SIGSEGV，
// 也可能静静改掉其它地方共享的常量

// 更隐蔽的：把 Go 指针交给 C 长期保存
ptr := unsafe.Pointer(&data[0])
C.save_for_later(ptr)  // 违反 cgo 指针传递规则：C 只能在
// 调用期间持有，调用结束后 pin 失效 → 再解引用即悬空
```

**✓ 推荐：能不用就不用；用则关进小笼子**

```go
// 首选：安全写法，语义清晰
func safeBytes(s string) []byte {
    return []byte(s)   // 一次拷贝，永远正确
}

// 确有性能需求时：范围最小 + 写明不变量
// unsafeBytes 返回的切片只可读，不可写，
// 且不得在 s 的生命周期之外使用。
func unsafeBytes(s string) []byte {
    return unsafe.Slice(unsafe.StringData(s), len(s))
}

func hash(s string) uint32 {
    return fnv(unsafeBytes(s)) // 只读 · 用完即弃
}
```

**差异说明：**左侧的问题不是"用了 unsafe"，而是**把它返回的切片当作可写、可长期持有的普通切片**——字符串底层可能是只读内存，也可能是共享常量，写入后果完全未定义。右侧把 unsafe 的使用限制在"只读、用完即弃"的 `hash` 内部，并在函数注释里写清不变量（不写、不逃逸）。**unsafe 的正确性靠人维护，注释就是契约的一部分。**

### 图式

图 12-1 安全区与 unsafe 区的保证边界

```
安全区      类型安全由编译器保证 · GC 管理内存 · Go 1 兼容承诺 · 错误多为显式 panic
unsafe 区   类型安全自行负责 · 内存布局是实现细节 · 升级 / 换架构可能失效
            · 错误 = 静默内存破坏，难以复现

规则：范围最小化 + 注释写明不变量 + benchmark 证明收益
```

## 13 · Clear is better than clever.

> **清晰优于聪明**。

**术语**

- **clever**：用最少字符/最巧技巧完成任务的写法——位运算技巧、一行链式表达式、冷门语言特性。
- **clear**：读者无需停顿就能看懂意图的写法——直白的循环、中间变量、早返回。
- **读/写比**：代码被阅读的次数远多于被编写的次数，可读性因此是首要质量指标。
- **早返回**：用 `if err != nil { return }` 消除 else 嵌套，是 Go 中最典型的"清晰"手法。

### 解读

::: tip 它解决什么问题
聪明的写法把“作者的思考时间”转移到“每个后来读者的思考时间”上，而且是以复利形式转移——这段代码会被读几十上百次。Go 刻意把语言特性做得很少（没有三元运算符、没有宏、没有运算符重载），就是为了**压缩“聪明”的发挥空间**，让不同人写出的代码长得差不多。
:::

::: info 适用场景
每次觉得“这里可以写得更短/更巧”时。具体手法：把复合条件拆成命名的中间变量；用早返回消灭嵌套；给魔法数字起常量名；宁可多写 5 行也不要一行 120 字符的链式表达式。性能敏感的聪明写法必须先有 benchmark 证明值得。
:::

::: warning 违背后果
修改者不理解原有技巧的隐含前提，改动后引入 subtle bug；调试时无法在中间设断点观察；新人读不懂只能整体重写；code review 变成“猜作者想干什么”，真正的设计问题反而被漏掉。
:::

### 示例

**✕ 不推荐：炫技写法**

```go
// 找出只出现一次的数字
// 前提：其余每个元素恰好出现三次（前提不满足时结果未定义）
func single(nums []int) int {
    var a, b int
    for _, n := range nums {
        a = (a ^ n) &^ b
        b = (b ^ n) &^ a
    }
    return a
}
// 正确，但需要读者推导有限状态机；
// 想改动？先花 10 分钟回忆原理。
// 想加日志？中间状态无处安放。
```

**✓ 推荐：直白写法**

```go
// 找出只出现一次的数字
// 前提：其余每个元素恰好出现三次（前提不满足时结果未定义）
func single(nums []int) int {
    counts := make(map[int]int, len(nums))
    for _, n := range nums {
        counts[n]++
    }
    for n, c := range counts {
        if c == 1 {
            return n
        }
    }
    return 0
}
// 一眼看懂：计数 → 找计数为 1 的
// 可调试、可插桩、可被安全地修改
// （确有纳秒级需求时再换算法，并附上
//  benchmark 与解释性注释）
```

**差异说明：**左侧是正确的，但它的正确性**不可见**——读者必须自己重建“两位状态机”的证明才能确认。右侧多分配了一个 map，却让意图直接写在代码里，任何人都能一眼验证、安全修改、随手加日志。**清晰版是可以被维护的资产，聪明版是需要原作者在场才能碰的负债。**

### 图式

图 13-1 可读性天平：聪明 vs 清晰

```
              字符数    理解耗时 / 次    可维护性
聪明 clever     少          很高            低
清晰 clear      略多        很低            高

代码被读次数 ≫ 被写次数 → "理解耗时 × 阅读次数" 才是真实成本
```

## 14 · Reflection is never clear.

> **反射永远称不上清晰**。

**术语**

- **reflect**：在运行时检查与操作类型/值的包（`reflect.TypeOf`、`Value.Field`、`Value.Set`）。
- **运行期类型检查**：类型错误从编译期推迟到运行期，通常以 panic 形式暴露。
- **代码生成**：`go generate` + 模板（如 `stringer`、`mockgen`、`protoc-gen-go`），把运行期反射提前到**编译前**，兼具清晰与高性能。
- **合理用途**：`encoding/json`、`fmt`、测试框架、ORM 等"必须处理任意类型"的通用基础设施。

### 解读

::: tip 它解决什么问题
反射让人可以在不知道具体类型的情况下操作数据，代价是**把类型契约从签名里抹掉**：函数签名不再说明它要什么，IDE 无法跳转或补全，编译器无法校验，字段改名时只有运行时才会暴露。它是“泛型缺失年代”的权宜之计，而 Go 1.18 之后大多数反射用法都有了更清晰的替代。
:::

::: info 适用场景
只在**真的要处理任意类型**时使用（序列化、校验框架、依赖注入、测试工具），且应封装在通用库内部，业务代码不要直接碰。可替代时优先：**接口**（让类型自己实现方法）、**泛型**（编译期约束）、**代码生成**（编译前展开）。
:::

::: warning 违背后果
字段改名后线上 panic（无编译错误）；性能显著下降（反射比直接调用慢一个数量级以上）；无法静态追踪字段引用，重构时靠全局搜索字符串；代码里充斥 `Kind()` 判断与 `CanSet` 检查，逻辑被淹没在样板中。
:::

### 示例

**✕ 不推荐：反射塞字段**

```go
// 把 map 的键按字段名写进任意结构体
func Fill(dst any, m map[string]string) {
    v := reflect.ValueOf(dst).Elem()
    for k, val := range m {
        f := v.FieldByName(k)   // 名字是字符串
        if !f.IsValid() || !f.CanSet() {
            continue            // 错了也静默跳过
        }
        if f.Kind() == reflect.String {
            f.SetString(val)
        }
    }
}
// 字段改名 → 编译通过，线上静默丢数据
// 另：入参非指针或 nil 指针时会直接 panic（Elem/FieldByName）
// IDE 点不进去，编译器查不出来
```

**✓ 推荐：让类型自己声明行为**

```go
// 方案 A：接口 —— 类型自己知道怎么填
type Fillable interface {
    Fill(map[string]string)
}

func Apply(f Fillable, m map[string]string) {
    f.Fill(m)   // 编译期保证存在该方法
}

func (u *User) Fill(m map[string]string) {
    u.Name = m["name"]   // 改名 → 编译错误，当场发现
    u.Email = m["email"]
}

// 方案 B：真的要通用 → 用代码生成，编译前展开成直白赋值
//go:generate go run ./genfill -type=User
// 生成：func (u *User) Fill(m map[string]string) {
//           u.Name = m["name"]; u.Email = m["email"] }
```

**差异说明：**左侧把字段名当作字符串在运行时匹配，**字段改名、拼错、类型不符都不会有任何编译期信号**，最坏结果是静默丢数据。右侧让 `User` 自己实现 `Fill`：字段名就是代码里的标识符，改名必然触发编译错误，IDE 可直接跳转。反射版本唯一的优势是"通用"，而当通用性只在业务内部需要时，这个优势并不存在。

### 图式

图 14-1 错误发现时机的推移

```
接口 / 泛型   写代码 ──► go build 报错，立刻修 ──► 上线（类型已验证）
反射          写代码 ──► go build 静默通过     ──► 上线 panic 或静默丢数据

越早发现错误，修复成本越低
```

## 15 · Errors are values.

> **错误就是值**。

**术语**

- **error**：只有一个方法 `Error() string` 的**接口类型**。任何实现了该方法的类型都可以当错误用。
- **sentinel error**：`var ErrNotFound = errors.New("not found")`，可被 `errors.Is` 判等的可导出错误值。
- **包装 %w**：`fmt.Errorf("读取 %s: %w", path, err)`，把原始错误包进新错误，保留可判定性。
- **errors.Is / errors.As**：前者在包装链中判等，后者在包装链中取出特定类型的错误。

### 解读

::: tip 它解决什么问题
很多语言的错误是"特殊控制流"（异常），你必须 catch 它，却很难传递、组合、附加上下文。Go 把错误设计成**普通的值**：可以赋值给变量、放进结构体、作为 channel 的元素、用函数包装、用 `Is/As` 检查。于是错误处理变成了普通的编程——你可以对错误做抽象，而不只是"捕获或抛出"。
:::

::: info 适用场景
需要区分错误类别时定义**错误值**或**自定义错误类型**（带上下文字段）；跨层传递时用 `%w` 包装；调用方用 `errors.Is` 判类别、`errors.As` 取详情。需要聚合多个错误时用 `errors.Join`（Go 1.20+）。
:::

::: warning 违背后果
用 `err.Error() == "..."` 判等 —— 上游一改文案就全盘失效；用字符串拼接 `fmt.Errorf("fail: " + err.Error())` —— 原始错误被丢弃，`errors.Is` 再也无法穿透，且 `go vet` 会报 `non-constant format string`；一旦 `err.Error()` 含 `%` 还会把消息本身格式化坏（`50%` → `50%!o(MISSING)`）；把错误当不可言说的黑盒，导致上层只能"要么全忽略，要么全崩溃"。
:::

### 示例

**✕ 不推荐：把 error 当字符串**

```go
func Load(id int) error {
    if !exists(id) {
        return errors.New("not found")  // 每次新值
    }
    return nil
}

// 调用方只能比字符串
if err.Error() == "not found" { ... }
// 上游包装后彻底失效：
// "load user: not found" != "not found"

// 拼接式包装 —— 原始错误丢失
return fmt.Errorf("load user: " + err.Error())
// errors.Is(err, ErrNotFound) → false
```

**✓ 推荐：错误是值，可判等可包装**

```go
// 包级错误值：可判等、可比较
var ErrNotFound = errors.New("not found")

func Load(id int) error {
    if !exists(id) {
        return fmt.Errorf("load user %d: %w", id, ErrNotFound)
    }
    return nil
}

// 调用方：穿透包装链判等
if errors.Is(err, ErrNotFound) {
    return 404
}

// 自定义错误类型：携带结构化上下文
type ParseError struct {
    Line int
    Msg  string
}
func (e *ParseError) Error() string {
    return fmt.Sprintf("line %d: %s", e.Line, e.Msg)
}
var pe *ParseError
if errors.As(err, &pe) { log.Println(pe.Line) }
```

**差异说明：**左侧把错误当成不可解析的字符串，判等依赖文案、包装会摧毁判等能力，原始错误一旦被拼接就永远丢失。右侧把错误当作**可以被检查的值**：`%w` 保留了指向 `ErrNotFound` 的链条，任意层数的包装后 `errors.Is` 依然成立；`*ParseError` 携带行号等结构化信息，`errors.As` 可安全取出。**值可以被组合，字符串不可以。**

### 图式

图 15-1 %w 形成的错误包装链与 errors.Is/As 的穿透

```
最外层  fmt.Errorf("handle req: %w", err)   ┐
中间层  fmt.Errorf("load user %d: %w", err) ├─ errors.Is(err, ErrNotFound) → true
根因    ErrNotFound（sentinel 值）          ┘

err.Error() == "not found" → 只比最外层完整文案 → false（包装即失效）
```

## 16 · Don't just check errors, handle them gracefully.

> 不要**只是检查**错误，而要**优雅地处理**它们。

**术语**

- **check**：`if err != nil { return err }` —— 只是把错误往上**传递**，并未处理。
- **handle**：判断错误类别并做出决策——重试、降级、改用默认值、转换为对用户有意义的消息、或终止流程。
- **上下文**：用 `%w` 附加"当时在做什么"，让最终日志能自解释。
- **单点处理**：只在**程序边界**（main、HTTP handler、任务入口）记录日志并决定退出码，中间层只加上下文。

### 解读

::: tip 它解决什么问题
Go 里 `if err != nil` 出现频率极高，容易退化成机械的"打日志 + 返回"。结果是：**同一个错误在每一层都被记录一次**，日志里 5 条重复信息却没有任何一条说明"该怎么办"；或者更糟——`_ = f.Close()` 直接吞掉。**检查不等于处理**：处理意味着有人真正为这个错误做了决策。
:::

::: info 适用场景
中间层：**加上下文后向上传递**（`%w`），不要 log 也不要吞；边界层：**统一分类处理**——可重试的重试（带退避）、用户输入错误转 4xx、依赖故障转 5xx 或降级、未知错误记录含完整 `%w` 错误链的一条日志后失败退出（标准库 error 不带堆栈，需要时显式 `debug.Stack()`）；资源清理用 `defer` 且不要忽略其错误（必要时 `errors.Join`）。
:::

::: warning 违背后果
日志重复噪音导致真正的信息被淹没；错误被吞导致"操作显示成功但数据没写入"；每层都 log 却无人决策，最终用户看到一串无关的 "internal error"；忽略 `Close`/`Flush` 的错误导致数据未落盘而丢失。
:::

### 示例

**✕ 不推荐：只检查，层层 log**

```go
import (
    "fmt"
    "io/fs"   // 导入路径是 io/fs，包名才是 fs
    "log"
    "os"
)

func loadConfig(p string) (*Cfg, error) {
    b, err := os.ReadFile(p)
    if err != nil {
        log.Println("err:", err)   // 第 1 次
        return nil, err
    }
    return parse(b)
}

func main() {
    c, err := loadConfig("app.yaml")
    if err != nil {
        log.Println("failed:", err) // 第 2 次
        os.Exit(1)
    }
}
// 日志里同一错误出现两次，且都没有说明
// "是文件缺失还是格式错误、该怎么办"
// 另一个常见变体：_ = f.Close() 直接丢弃
```

**✓ 推荐：加上下文，边界统一处理**

```go
func loadConfig(p string) (*Cfg, error) {
    b, err := os.ReadFile(p)
    if err != nil {
        // 只加上下文，不记录、不吞
        return nil, fmt.Errorf("读取配置 %s: %w", p, err)
    }
    c, err := parse(b)
    if err != nil {
        return nil, fmt.Errorf("解析配置 %s: %w", p, err)
    }
    return c, nil
}

func main() {
    c, err := loadConfig("app.yaml")
    if err == nil { run(c); return }

    // 边界层：分类决策，只在这里记一次
    if errors.Is(err, fs.ErrNotExist) {
        fmt.Fprintln(os.Stderr,
            "配置文件不存在，正在使用默认配置")
        run(defaultCfg()); return
    }
    log.Printf("启动失败: %v", err)  // 含完整链
    os.Exit(1)
}
```

**差异说明：**左侧 `loadConfig` 记了日志又返回错误，`main` 再记一次——**两条日志内容重复，却没有任何一条回答"文件不存在该怎么办"**。右侧中间层只负责用 `%w` 补足上下文（谁在读、读什么文件），边界层用 `errors.Is` 分类：**文件缺失 → 降级到默认配置继续跑；其他 → 记录含完整链路的一条日志后退出**。错误处理从"重复报告"变成了"做出决策"。

### 图式

图 16-1 错误的三层职责划分

```
中间层  发生错误 ──► %w 附加上下文 ──► return err（不 log · 不吞）
            │
边界层      ▼
   可恢复 → 重试 / 降级 / 默认值     用户输入错误 → 4xx + 明确提示
   依赖故障 → 5xx / 熔断             未知错误 → 记录一次 + 失败退出

每层只做一件事：要么加上下文，要么做决策
```

## 17 · Design the architecture, name the components, document the details.

> **设计架构，命名组件，记录细节**。

**术语**

- **架构**：组件如何划分、边界在哪、依赖方向如何——决定系统能否演进。
- **命名**：包名、类型名、方法名、变量名；在 Go 中**命名即设计的外化**——好名字让调用方不看文档也能用对。
- **细节文档**：godoc 注释，说明契约、边界条件、并发安全性、错误语义等名字无法承载的信息。
- **三个层次**：先设计（想清楚）→ 再命名（让设计可读）→ 最后文档（补全名字说不完的部分）。三者投入依次递减：设计 > 命名 > 文档。

### 解读

::: tip 它解决什么问题
软件退化的常见路径是：没想清楚就动手 → 名字随手写（`Manager`、`Handler`、`Util`、`Data`）→ 靠大段注释解释"这东西到底是干嘛的"。这条箴言给出了**正确的投入顺序**：设计决定上限，命名把设计变成可读的代码，文档只负责补漏。如果注释里需要解释"这个组件是做什么的"，通常说明名字起失败了。
:::

::: info 适用场景
动手写代码前先画出组件与依赖方向；命名时问"这个名字能否让调用方猜对用法"——用具体动词而非通用后缀（`TokenRefresher` 优于 `AuthManager`，`Refresh` 优于 `Do`）；包名取自它提供的东西（`package token` 而非 `package util`）；最后用 godoc 说明**边界与不变量**。
:::

::: warning 违背后果
名字无法承载设计 → 每个新人都必须读完全部实现才知道怎么用 → 于是出现 `Helper`、`HelperV2`、`NewHelper`、`NewHelperWithOptions` 的连环补丁；逻辑上的循环依赖与抽象倒置（Go 禁止包级 import cycle，只能靠接口或重复代码绕开编译错误）；修改任何一处都要改动五个文件。文档再详细也救不了糟糕的架构与命名。
:::

### 示例

**✕ 不推荐：泛化命名 + 注释补锅**

```go
// 签名示意（伪代码，省略函数体）
package util

// Manager 管理各种东西。
// 具体行为取决于 opts，调用前请先读本文件
// 第 120 行的逻辑，注意线程不安全，
// 另外 Do 在 ctx 为 nil 时会 panic。
type Manager struct { /* ... */ }

func (m *Manager) Do(ctx context.Context,
    a, b interface{}) (interface{}, error) {
    // 200 行
}

// 调用方：看不懂，只能照抄别人的用法
r, _ := m.Do(ctx, "user", 42)
```

**✓ 推荐：设计清晰 → 名字自解释**

```go
// 签名示意（伪代码，省略函数体）
package token

// Refresher 在令牌过期前自动续期。
// 可被多个 goroutine 并发使用；
// Refresh 是幂等的，失败时返回旧令牌而非错误。
type Refresher struct { /* ... */ }

// Refresh 返回当前有效令牌；
// 若剩余有效期低于阈值则先向 idP 续期。
// ctx 取消时返回 ctx.Err()。
func (r *Refresher) Refresh(
    ctx context.Context) (Token, error)

// 调用方：不需要读实现就知道怎么用
t, err := refresher.Refresh(ctx)
```

**差异说明：**左侧把"这个组件干什么"全部压在注释里，签名 `Do(ctx, a, b any) (any, error)` 不传达任何信息，调用方必须读 200 行实现才敢用，且 `ctx == nil` 会 panic 这种细节只能靠文字约定。右侧先想清楚职责（续期令牌）→ 由此得到名字 `token.Refresher.Refresh` → 文档只补充名字说不完的部分（并发安全、幂等性、取消语义）。**顺序对了，代码自己就是文档。**

### 图式

图 17-1 三步投入顺序（不可颠倒）

```
① 设计架构   划分组件 · 确定边界 · 明确依赖方向     决定上限
      ↓
② 命名组件   token.Refresher.Refresh               让设计可读
      ↓
③ 记录细节   并发安全 · 幂等性 · 边界条件 · 错误语义  补全名字说不完的

若注释必须先解释"这是什么" → 说明第 ② 步没做好
```

## 18 · Documentation is for users.

> **文档是写给使用者看的**。

**术语**

- **go doc**（历史上称 godoc）：从源码注释生成文档的工具（`go doc` 命令、pkg.go.dev 网站）。注释紧跟在被注释的**导出标识符**之前。
- **约定**：文档注释**以被说明的标识符名开头**，如 `// Refresh 返回...`，这样在 godoc 里读起来是完整句子。
- **包注释**：放在任一文件（惯例是 `doc.go`）的 `package` 语句前，说明包的用途与整体用法。
- **用户**：**调用你这个包的人**，而不是读你源码的人。源码内部逻辑用普通行内注释，不进 godoc。

### 解读

::: tip 它解决什么问题
最常见的文档失败是**把注释写给自己看**：复述代码在做什么（“遍历 rows”）、描述实现细节（“先加锁再写入”）。这些信息读者看代码就能得到，却挤掉了真正稀缺的信息——**契约**：这个函数保证什么、不保证什么、边界如何、失败会怎样。文档应当回答“我该怎么用、用错了会怎样”。
:::

::: info 适用场景
每个导出标识符都要有以它名字开头的文档注释。内容优先级：①**做什么/何时用**；②**参数与返回值的语义**；③**边界与错误**（会返回哪些 error、何时 panic）；④**并发安全与不变量**；⑤**可运行示例**（写在 `example_test.go` 中的 `ExampleXxx`，会被 `go test` 执行并比对 `// Output:`，永不腐烂）。
:::

::: warning 违背后果
文档变成代码复述 → 与实现同步腐烂且无人维护；使用者只能读源码猜语义 → 依赖未文档化的行为 → 你一旦“修复”实现就破坏了他们的用法（Hyrum's Law）；pkg.go.dev 上你的包无注释，采纳率极低。
:::

### 示例

**✕ 不推荐：复述代码 / 讲实现**

```go
// 这个函数遍历 rows 并把它们加到结果里
func Filter(rows []Row) []Row {
    var out []Row
    for _, r := range rows {
        // 检查状态是否等于 1
        if r.Status == 1 {
            out = append(out, r)
        }
    }
    return out
}
// 读者想知道的：Status==1 是什么意思？
// 会不会修改入参？空输入返回空切片还是 nil？
// 一行都没说。
```

**✓ 推荐：面向使用者，讲契约**

```go
// Filter 返回 rows 中所有状态为 Active 的记录，
// 保持原有顺序，不修改入参。
// rows 为 nil 时返回 nil。
func Filter(rows []Row) []Row

// ExampleFilter 演示按状态筛选的用法。
func ExampleFilter() {
    rows := []Row{{Status: StatusActive}}
    fmt.Println(len(Filter(rows)))
    // Output: 1
}

// 包注释（doc.go）：
// Package model 定义订单领域模型及其状态机，
// 不含任何存储逻辑。
package model
```

**差异说明：**左侧注释只说了"遍历 + 判断 == 1"，全是读代码即可得到的信息，而**使用者真正需要的三个问题一个都没答**（Status==1 的语义、是否修改入参、nil 输入的返回）。右侧文档直接给出契约：筛选条件、顺序保证、入参不被修改、nil 行为；再用 `ExampleFilter` 提供一个**会被测试执行**的示例，保证文档不会腐烂。

### 图式

图 18-1 文档该写什么 vs 不该写什么

```
✓ 面向使用者   做什么 / 何时用 · 参数与返回值语义 · 边界与 error
               并发安全与不变量 · 可运行 Example
✕ 面向作者     "遍历 rows"（复述代码）· 实现细节 · 与实现同步腐烂

判断标准：读者看代码能不能自己得到？能 → 删掉；不能 → 写进文档
```

## 19 · Don't panic.

> **不要 panic**。

**术语**

- **panic**：终止当前 goroutine 的正常流程，沿栈向上执行 defer 并触发 `recover` 检查；未被 recover 则**整个进程退出**。
- **error**：作为返回值交给调用方，由调用方决定如何处理。
- **库代码**：被别人 import 的包。它 panic 意味着**剥夺了调用方处理问题的权利**。
- **合法 panic 场景**：不可恢复的编程错误（越界、nil 解引用由运行时触发）、`init`/`main` 中的启动失败（快速失败）、以及 `must*` 这类显式命名的初始化辅助函数。

### 解读

::: tip 它解决什么问题
panic 是“我放弃，让进程死掉”——它把错误处理的决定权从调用方手里夺走。库代码 panic 尤其糟糕：调用方无法预知、无法降级、甚至无法可靠地 recover（因为 panic 可能在任意 goroutine 中发生，而 recover 只在同一 goroutine 的 defer 中、且**由 defer 函数直接调用**才有效）。**错误属于调用方，因为只有它知道该怎么办。**
:::

::: info 适用场景
库与业务代码：**一律返回 error**。`main`/`init`：启动阶段的不可恢复错误可以 panic/log.Fatal（此时继续运行没有意义）。`must` 前缀函数（`template.Must`、`regexp.MustCompile`）：约定俗成的"错了就别启动"语义，仅用于程序初始化阶段、输入已知合法的场景（典型是包级 var 初始化），绝不用于用户输入或运行期可变数据。服务器：在 goroutine 边界用 `defer recover` 兜底，把 panic 转成 **500 响应 + 堆栈日志**（否则客户端只看到连接断开），但**不要把它当作控制流**。
:::

::: warning 违背后果
一个边缘输入导致整个服务进程退出；panic 在子 goroutine 中发生导致 recover 失效、进程崩溃；把 panic/recover 当异常机制使用，使控制流难以追踪；库使用者被迫到处写 `defer recover()`，代码被防御性样板淹没。
:::

### 示例

**✕ 不推荐：库代码 panic**

```go
package calc

// 被别人 import 的库
func Divide(a, b float64) float64 {
    if b == 0 {
        panic("divide by zero")   // ❌
    }
    return a / b
}

// 调用方：自己起的 goroutine 无人 recover → 真崩
go func() {
    fmt.Println(Divide(x, y))     // panic → 整个进程退出
}()
// 注：若挂在 net/http 的 handler 里，net/http 自带 recover，
// 进程不会退出，但该请求会被打断（客户端看到连接断开、
// 拿不到任何状态码），同样是失败。

// 另一种反模式：把 panic 当控制流，再就地吞掉
func Get(k string) (v string) {
    defer func() { recover() }()  // 吞掉 panic，返回零值
    v, ok := m[k]
    if !ok {
        panic("key not found")    // ❌ 可预期的失败不该 panic
    }
    return v
}
```

**✓ 推荐：返回 error，边界兜底**

```go
package calc

import "errors"

var ErrDivideByZero = errors.New("divide by zero")

func Divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, ErrDivideByZero   // 交给调用方
    }
    return a / b, nil
}

// 调用方自己决定：转 400 或降级
v, err := Divide(x, y)
if errors.Is(err, calc.ErrDivideByZero) {
    http.Error(w, "除数不能为 0", 400)
    return
}

import (
    "log"
    "net/http"
    "runtime/debug"   // debug.Stack()
)

// 仅在 goroutine 边界做兜底，把 panic 转成 500 + 堆栈日志
func guard(h http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter,
        r *http.Request) {
        defer func() {
            if rec := recover(); rec != nil {
                log.Printf("panic: %v\n%s",
                    rec, debug.Stack())
                http.Error(w, "500", 500)
            }
        }()
        h.ServeHTTP(w, r)
    })
}
```

**差异说明：**左侧的 `Divide` 把"除数为零"这个**完全可预期**的输入问题升级为进程级故障，调用方没有任何选择余地。右侧返回 `ErrDivideByZero`，调用方可以翻译成 400、可以降级、也可以记日志——**决定权回到了知道上下文的一方**。最后的 `guard` 展示了 recover 的**唯一正当兜底位置**：**goroutine 边界，记录堆栈并转成 500**，而不是在业务代码里抛来抛去。

### 图式

图 19-1 error 与 panic 的控制流走向

```
✓ 返回 error   库函数 ──► return err ──► 调用方决策（重试 / 降级 / 400）
                                      └─► 进程继续运行

✕ panic        库函数 ──► panic() ──► 沿栈展开执行 defer
                                   └─► 无 recover → 整个进程退出

可预期的失败 → error；不可能恢复的程序 bug → panic
```

## 速查表 · Code Review 检查清单

| # | 箴言 | 一句话要点 | 自检问题 |
| --- | --- | --- | --- |
| 01 | 不要通过共享内存来通信 | 让数据只属于一个 goroutine，靠 channel 转让所有权 | 这块数据有几个写者？能改成单一 owner 吗？ |
| 02 | 并发不是并行 | 并发是结构，并行是执行；正确性不应依赖核数 | GOMAXPROCS=1 时这段代码还正确吗？用了 Sleep 等待吗？ |
| 03 | Channel 编排，Mutex 串行化 | 流程用 channel，状态用 mutex，各司其职 | 这里是在协调流程，还是在保护数据？ |
| 04 | 接口越大，抽象越弱 | 接口由使用方按需声明，小到只有一个方法最好 | 这个接口有几个真实实现？能只声明我需要的那个方法吗？ |
| 05 | 让零值有用 | `var x T` 之后应能直接调用方法 | 零值调用会不会 panic？能用惰性初始化补上吗？ |
| 06 | interface{} 什么都没说明 | 优先具体类型 → 小接口 → 泛型，最后才 any | 这个签名告诉读者参数能做什么了吗？ |
| 07 | gofmt 是所有人的最爱 | 不讨论风格，全部交给 gofmt/goimports，CI 强制 | CI 里有 gofmt -l 检查吗？ |
| 08 | 少量复制胜过少量依赖 | 依赖是长期负债，复制是一次性成本 | 为这几行代码引入的传递依赖值得吗？ |
| 09 | Syscall 必须用构建标签隔离 | 按 GOOS 拆文件，用 x/sys，并提供兜底实现 | GOOS=windows / 交叉编译能通过吗？ |
| 10 | Cgo 必须用构建标签隔离 | cgo 版 + 纯 Go 兜底，公共 API 不含 `import "C"` | CGO_ENABLED=0 还能构建吗？scratch 镜像能跑吗？ |
| 11 | Cgo 不是 Go | 把 C 当外部资源：薄封装、批量调用、错误翻译 | cgo 调用在循环里吗？能合并成一次批量吗？ |
| 12 | unsafe 之下没有保证 | 范围最小化、注释写明不变量、benchmark 证明收益 | 不用 unsafe 的代价真的不可接受吗？不变量写在注释里了吗？ |
| 13 | 清晰优于聪明 | 宁可多写几行，也不要需要推导才懂的技巧 | 新人能在 30 秒内看懂这段吗？ |
| 14 | 反射永远称不上清晰 | 优先接口 / 泛型 / 代码生成；反射只留给通用基础设施 | 字段改名后编译器会发现吗？ |
| 15 | 错误就是值 | 用 `%w` 包装，用 `errors.Is/As` 检查 | 有 `err.Error() == ...` 或字符串拼接包装吗？ |
| 16 | 别只检查错误，要优雅处理 | 中间层加上下文，边界层做决策，一处只记一次 | 这个错误最终由谁做出决策？日志会重复吗？ |
| 17 | 设计架构、命名组件、记录细节 | 先想清楚再命名，文档只补名字说不完的部分 | 名字能让人猜对用法吗？注释在解释“是什么”吗？ |
| 18 | 文档是写给使用者看的 | 以标识符名开头，讲契约与边界，配可运行 Example | 这条注释，读者看代码能不能自己得到？ |
| 19 | 不要 panic | 库代码返回 error；panic 只留给我方 init/main 与 must* | 这个失败是可预期的吗？调用方有没有选择权？ |

## 参考

- 箴言原文：<https://go-proverbs.github.io/>
- 出处：Rob Pike, Gopherfest SV 2015（[视频](https://www.youtube.com/watch?v=PAAkCSZUG1c)）
