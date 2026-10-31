from pathlib import Path
from html import escape

OUT=Path(__file__).parent
C={'bg':'#F7F6F2','ink':'#172D3B','muted':'#687780','teal':'#176D67','soft':'#EAF3EF','line':'#E0E5E1','white':'#FFFFFF','wash':'#F2F4F1','amber':'#91662A','amberbg':'#FBF4E8'}
def rect(a,x,y,w,h,fill='white',r=12,stroke='line',dash=False):
    a.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{C.get(fill,fill)}" stroke="{C.get(stroke,stroke)}"'+(' stroke-dasharray="4 4"' if dash else '')+'/>')
def text(a,x,y,s,size=14,color='ink',weight=400,lh=23):
    for i,line in enumerate(s.split('\n')):a.append(f'<text x="{x}" y="{y+i*lh+size*.86}" font-size="{size}" font-weight="{weight}" fill="{C.get(color,color)}">{escape(line)}</text>')
def line(a,x,y,w,color='line',thick=1):a.append(f'<path d="M{x} {y}h{w}" stroke="{C.get(color,color)}" stroke-width="{thick}"/>')
def button(a,x,y,w,s,primary=False):
    rect(a,x,y,w,36,'teal' if primary else 'white',8,'teal' if primary else 'line')
    text(a,x+13,y+11,s,13,'white' if primary else 'ink',550)
def field(a,x,y,w,label,value):
    text(a,x,y,label,12,'muted');rect(a,x,y+22,w,39,'white',7);text(a,x+11,y+34,value,14);text(a,x+w-22,y+34,'⌄',13,'muted')

a=['<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1000" viewBox="0 0 1440 1000"><style>text{font-family:"PingFang SC","Noto Sans SC",sans-serif}</style>',f'<rect width="1440" height="1000" fill="{C["bg"]}"/>']
rect(a,44,20,27,27,'teal',8,'teal');a.append('<path d="M50 30h9m-4 6h9" stroke="white" stroke-width="2.5" stroke-linecap="round"/>')
text(a,81,22,'TeamLink',20,'ink',650);text(a,200,27,'导出体验共创',13,'muted')
text(a,1035,28,'撤销',13,'muted');text(a,1100,28,'重做',13,'#AAB3B5')
button(a,1173,16,110,'保存方案');button(a,1297,16,99,'分享副本')
line(a,44,69,1352)
text(a,44,97,'直接改作品，整个过程马上改变。',24,'ink',650)
text(a,44,134,'作品、规则、数据与验证保持连接；想法可以留下，也可以交给自己的 Codex 继续做。',14,'muted')
# Stable workspace views, not workflow stages.
for x,label,active in [(44,'作品与规则',True),(216,'数据与文件',False),(388,'验证与过程',False)]:
    text(a,x+12,177,label,14,'teal' if active else 'muted',600 if active else 400)
    if active:line(a,x,205,132,'teal',2)
line(a,44,205,970)
# Working product.
rect(a,44,224,623,337,'white',14)
text(a,68,244,'正在编辑的作品',12,'muted');text(a,509,244,'预览：初始界面',12,'muted')
text(a,68,276,'导出项目记录',26,'ink',650);line(a,68,309,156,'teal')
text(a,68,326,'按月份与分类筛选，导出当前看到的数据。',14)
field(a,68,367,176,'月份','2026 年 10 月');field(a,258,367,161,'分类','产品')
button(a,435,389,208,'导出记录   →',True)
rect(a,68,449,575,80,'wash',9,'wash')
text(a,86,465,'当前列表：3 条记录',15,'ink',550)
text(a,86,494,'点击文字直接修改；结果与下载文件由当前规则推演。',12,'muted')
# Rules remain adjacent to the live artifact.
rect(a,687,224,327,337,'white',14)
text(a,709,244,'行为规则',17,'ink',600)
text(a,709,285,'超时后保留筛选条件',14)
rect(a,951,282,39,22,'line',11,'line');a.append('<circle cx="962" cy="293" r="8" fill="white"/>')
line(a,709,325,283)
text(a,709,344,'重试时使用',12,'muted')
rect(a,709,371,283,36,'wash',8,'wash');rect(a,712,374,139,30,'white',6,'white')
text(a,731,382,'眼前条件',13,'teal',550);text(a,876,382,'首次条件',13,'muted')
line(a,709,428,283)
text(a,709,452,'等待',14);text(a,760,440,'800',25,'teal',650);line(a,758,476,58,'teal')
text(a,830,452,'毫秒后超时',13);text(a,938,454,'↔ 拖动',11,'muted')
text(a,709,510,'耗时假设与期望  ▸',12,'muted')
# Persistent causal ribbon is visible across the three workspace views.
text(a,44,590,'这版作品的因果摘要',17,'ink',600);text(a,807,594,'实时演算 · 不是后台执行记录',11,'muted')
traces=[('首次选择','10 月 / 产品 · 3 条','filters'),('超时以后','800 ms · 条件清空','timeout'),('再次请求','全部 / 全部 · 10 条','retry'),('文件结果','10 条 · 多出 7 条','file')]
for i,(label,value,_) in enumerate(traces):
    x=44+i*246
    rect(a,x,625,232,88,'amberbg' if i in [1,3] else 'white',10,'amberbg' if i in [1,3] else 'line')
    text(a,x+15,639,label,12,'muted');text(a,x+15,669,value,15,'amber' if i in [1,3] else 'ink',550)
# Real computed output near the artifact rather than after a long dashboard.
rect(a,44,738,970,225,'white',14)
text(a,68,758,'当前规则会得到的文件',18,'ink',600);button(a,834,750,156,'下载推演 CSV  ↓')
text(a,68,790,'文件与最初选择不同。下面直接展示原本选中和额外导出的记录。',12,'muted')
rect(a,68,819,922,28,'wash',6,'wash')
for x,label in [(82,'日期'),(242,'分类'),(358,'实际文件内容'),(826,'与首次选择对比')]:text(a,x,827,label,12,'muted',550)
rows=[('2026-10-03','产品','活动报名流程梳理','原本选中'),('2026-10-12','产品','导出失败反馈整理','原本选中'),('2026-09-18','研发','上月数据接口整理','额外导出')]
for i,row in enumerate(rows):
    y=857+i*27
    if i==2:rect(a,68,y-4,922,27,'amberbg',0,'amberbg')
    for x,value in zip([82,242,358,826],row):text(a,x,y,value,12,'amber' if i==2 else 'ink')
text(a,68,943,'预览 3 / 10 条；完整文件来自同一份数据。',11,'muted')
# Local project collaboration rail: honest asynchronous handoff, no fake online agents.
rect(a,1038,97,358,866,'white',14)
text(a,1060,120,'导出体验共创',19,'ink',600)
text(a,1060,156,'目标',11,'muted')
text(a,1060,178,'失败后不丢条件，拿到真正\n选中的数据。',15,'ink',450,lh=25)
text(a,1060,241,'本地项目 · 分享会打开独立副本',11,'muted')
line(a,1060,273,314)
for x,label,active in [(1060,'方案',False),(1145,'批注',False),(1232,'Agent 交接',True)]:
    text(a,x,292,label,13,'teal' if active else 'muted',600 if active else 400)
    if active:line(a,x-3,320,125,'teal',2)
text(a,1060,344,'把这次发现交给自己的 Codex',16,'ink',600)
rect(a,1060,380,314,67,'soft',9,'soft')
text(a,1074,393,'关注：超时后筛选条件被清空',13,'teal',550)
text(a,1074,421,'任务基于当前作品与选中的规则。',12,'muted')
text(a,1060,468,'带上这版作品、规则、数据和案例。\n只导出任务包，不会在网页启动 Agent。',12,'muted',400,lh=23)
button(a,1060,531,314,'导出 Agent 任务包  ↓',True)
text(a,1060,589,'在自己的 Codex 中处理，\n把返回的方案文件带回来。',13,'ink',450,lh=25)
button(a,1060,654,314,'导入 Codex 返回方案  ↑')
line(a,1060,720,314)
text(a,1060,742,'尚未导入返回方案',14,'muted',550)
text(a,1060,774,'导入后先看字段差异与效果变化，\n再决定是否采纳为新的方案。',12,'muted',400,lh=24)
text(a,1060,845,'版本已变化？先比较，不直接覆盖。',12,'teal',550)
text(a,1060,889,'这是异步文件交接。没有实时多人\n同步、虚构成员在线或后台 Agent 执行。',11,'muted',400,lh=22)
text(a,44,986,'虚构样例 · 作品与方案保存在本浏览器。分享副本不代表同一个在线房间。',10,'muted')
a.append('</svg>')
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'gatherthread-v3.svg').write_text(''.join(a),encoding='utf-8')
print('Created gatherthread-v3.svg, 1440×1000')
