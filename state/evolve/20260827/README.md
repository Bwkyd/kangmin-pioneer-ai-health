# 演化趋势体检 · 20260827

> 对象：`/Users/chenqiqiang/work/kangmin` ｜ 由 `aias-meta-evolve` 起。**演化即守约。**

| 文件 | 哪一步 | 谁填 |
|---|---|---|
| `trend.md` | **跟踪**——四个数：两把主尺（用例密度 · 导航成本）＋ 两个哨兵（冗余率 · 中位数） | 机器，每次重算 |
| `balance.md` | **平衡**——增信息量的同时，减复杂度 | **人** |
| `select.md` | **引导 · 正选择**——凭什么留下、什么时候淘汰 | **人** |
| `guard.sh` | **引导 · 负选择**——能跑的护栏 | 机器起草，人改阈值 |

跟踪，你在看；平衡，你在动手；引导，你退后一格，改的是规则。

这三层**不是互不重叠的三件事，是一个回路**：观测 → 局部干预 → 把有效的干预制度化。
护栏本身也在做平衡。**次序也不是死的**——新系统完全可以先立两条安全护栏，再慢慢攒趋势数据。
但**缺一层就会塌**：没有跟踪就在拍脑袋，没有平衡就只剩减复杂度一头，没有引导就得你永远在场。

## 现在做什么

1. 打开 `trend.md`，看「一句话」那一节——**两条线各自往哪走**
2. 打开 `balance.md`，回答第一问——**最宽那个目录装的是能力还是产物**
3. 打开 `select.md`，写下**收敛点**与**凭什么被留下**
4. 跑护栏，**然后故意违规一次**

```bash
bash guard.sh "/Users/chenqiqiang/work/kangmin"

# 故意建一个超宽目录。git 不跟踪空目录、也看不见未 add 的文件——
# 所以要在每个子目录里放个文件并 git add，护栏才看得见它
mkdir -p "/Users/chenqiqiang/work/kangmin/tmp-violate"/{a,b,c,d,e,f,g,h}
for d in "/Users/chenqiqiang/work/kangmin/tmp-violate"/*/; do touch "$d/x"; done
git -C "/Users/chenqiqiang/work/kangmin" add tmp-violate

bash guard.sh "/Users/chenqiqiang/work/kangmin"          # 它该拦下来并退非零

# 清场：撤掉这次故意的违规
git -C "/Users/chenqiqiang/work/kangmin" rm -rq --cached tmp-violate
rm -r "/Users/chenqiqiang/work/kangmin/tmp-violate"
```

## 放行判据

**不是「护栏写好了」，是「它真的拦下过东西」。**
没拦下来的护栏不算护栏；空的检查必然通过——那不叫通过，叫没查。

正选择那一半的判据是：**收敛点写成了一句话，且「凭什么留下」至少有一样可执行。**

## 复诊

改完那三件事，**重跑 `evolve.sh`**。第二次起 `trend.md` 才会有「方向」那一节——
**趋势要两个点才成立，一次体检只有位置。**

看方向时记住两件事：
- **两条线可能同时给出相反的信号**，那不是数据错了（实测中冗余率与用例密度就会打架）；
- **只跟一条线必有荒谬解**：只压复杂度，最优策略是什么都别做；
  只求「不重样」，最优策略是把变量名随机化。

历次账单按日期并排放在 `state/evolve/` 下——**这条曲线本身就是你的演化史**。

> 从一颗种子成长为一片森林，关键在于**有序演化，而非无序生长**。
