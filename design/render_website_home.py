from pathlib import Path
from html import escape

OUT=Path(__file__).parent
C={'paper':'#F7F6F2','ink':'#172D3B','muted':'#687780','teal':'#176D67','soft':'#EAF3EF','line':'#DDE3DE','white':'#FFFFFF','wash':'#F1F3EF','amber':'#91662A','amberbg':'#FBF4E8','darkline':'#37515D','light':'#D4E1DD','mint':'#9BC5B8'}
def text(a,x,y,s,size=16,color='ink',weight=400,lh=27):
    for i,line in enumerate(s.split('\n')):a.append(f'<text x="{x}" y="{y+i*lh+size*.86}" font-size="{size}" font-weight="{weight}" fill="{C.get(color,color)}">{escape(line)}</text>')
def box(a,x,y,w,h,fill='white',r=12,stroke='line'):
    a.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{C.get(fill,fill)}" stroke="{C.get(stroke,stroke)}"/>')
def line(a,x,y,w,color='line',thickness=1):a.append(f'<path d="M{x} {y}h{w}" stroke="{C.get(color,color)}" stroke-width="{thickness}"/>')
def button(a,x,y,w,label,primary=False,dark=False):
    fill='teal' if primary else 'ink' if dark else 'paper';stroke='teal' if primary else 'darkline' if dark else 'line'
    box(a,x,y,w,52,fill,8,stroke);text(a,x+21,y+18,label,15,'white' if primary or dark else 'ink',550)
def logo(a,x,y):
    box(a,x,y,30,30,'teal',8,'teal');a.append(f'<path d="M{x+7} {y+11}h9m-4 7h9" stroke="white" stroke-width="2.7" stroke-linecap="round"/>');text(a,x+42,y+2,'TeamLink',23,'ink',650)

a=['<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="2800" viewBox="0 0 1440 2800"><style>text{font-family:"PingFang SC","Noto Sans SC",sans-serif}</style>',f'<rect width="1440" height="2800" fill="{C["paper"]}"/>']
logo(a,88,29)
text(a,815,38,'体验作品',14,'muted');text(a,925,38,'工作方式',14,'muted');text(a,1035,38,'开源',14,'muted')
button(a,1153,19,199,'打开共创画布  ↗')
line(a,88,94,1264)
# Editorial first fold. The real, adjustable specimen begins inside the fold.
text(a,88,154,'产品共创，从一件能修改的作品开始',14,'teal',550)
text(a,88,200,'一起改作品，',66,'ink',650,lh=81)
text(a,88,282,'把想法变清楚。',66,'ink',650)
text(a,922,210,'你说的“保留输入”，\n和我理解的一样吗？',25,'ink',550,lh=38)
text(a,922,312,'直接改文案、数据和规则，马上看见结果。\n保留这一版、比较修改，再把具体问题\n交给自己的 Codex 继续做。',16,'muted',400,lh=29)
button(a,88,403,231,'直接体验，无需登录  →',True)
text(a,353,423,'看源码  ↗',15,'teal',550)
text(a,88,488,'不用把所有意思一次说完。先改一下，看看会发生什么。',15,'muted')
text(a,1194,491,'向下动手试  ↓',13,'muted')
# A real interactive specimen in implementation, rather than a screenshot hero.
box(a,88,542,1264,540,'white',16)
text(a,120,572,'先试一下：失败之后，筛选条件还在吗？',22,'ink',600)
text(a,120,611,'这个小作品可以直接改。所有结果在浏览器内计算，没有真实网络请求。',14,'muted')
line(a,120,646,1200)
box(a,120,672,735,264,'paper',11,'line')
text(a,145,696,'导出项目记录',25,'ink',600);line(a,145,728,152,'teal')
text(a,145,747,'选好月份和分类，导出你眼前的数据。',14)
for x,w,label,value in [(145,213,'月份','2026 年 10 月'),(376,194,'分类','产品')]:
    text(a,x,789,label,12,'muted');box(a,x,812,w,41,'white',7);text(a,x+12,825,value,14);text(a,x+w-23,825,'⌄',13,'muted')
box(a,589,812,241,41,'teal',7,'teal');text(a,610,825,'导出记录  →',14,'white',550)
text(a,145,884,'最初选中 3 条；当前规则会额外导出 7 条。',13,'amber',500)
text(a,897,683,'超时后保留筛选条件',16,'ink',550)
box(a,1276,678,45,25,'line',13,'line');a.append('<circle cx="1289" cy="690.5" r="9" fill="white"/>')
text(a,897,726,'试着打开开关，观察下面三组数字。',13,'muted')
line(a,897,765,424)
text(a,897,791,'最初选择',12,'muted');text(a,1056,791,'重试请求',12,'muted');text(a,1213,791,'最终文件',12,'muted')
text(a,907,826,'3',43,'ink',600);text(a,1000,839,'→',22,'muted');text(a,1058,826,'10',43,'amber',600);text(a,1153,839,'→',22,'muted');text(a,1214,826,'10',43,'amber',600)
text(a,897,900,'重试使用眼前条件 · 等待预算 800 毫秒',12,'muted')
line(a,120,967,1200)
text(a,120,990,'一个开关会改变界面、请求和文件，\n这些变化来自同一套规则。',16,'ink',450,lh=27)
button(a,1090,987,230,'打开完整画布  ↗',True)
text(a,88,1114,'可编辑样例，不是自动生成任意应用。你在完整画布里还能改数据、回看过程、保留对照。',13,'muted')
# Continuous process story, intentionally not a row of feature cards.
a.append(f'<rect x="0" y="1190" width="1440" height="643" fill="{C["ink"]}"/>')
text(a,88,1250,'让改动成为\n一次接得住的讨论。',39,'paper',600,lh=56)
text(a,88,1418,'想法、证据与具体版本放在一起，\n下一位就能从这里继续。',17,'light',400,lh=31)
text(a,88,1727,'每次修改，都能继续回到作品。',14,'mint',450)
steps=[('01','动手改','文案直接改，规则直接试。\n马上看到这次修改带来的结果。'),('02','留下方案','给值得保留的想法起个名字。\n原版不变，继续比较和尝试。'),('03','交给自己的 Codex','导出具体版本和问题，在自己的环境中处理。\n网页不会替你启动或冒充 Agent。'),('04','看过差异，再采纳','带回候选方案，先核对修改与实际效果。\n作品已经变化时，先解决版本冲突。')]
for i,(num,title,desc) in enumerate(steps):
    y=1256+i*132
    text(a,690,y+2,num,15,'mint',550);text(a,750,y,title,22,'paper',550)
    text(a,750,y+40,desc,14,'light',400,lh=24)
    if i<3:line(a,690,y+110,662,'darkline')
# Existing tools have specific jobs. Current public integration boundaries stay explicit.
text(a,88,1902,'让原来的工具，\n各做擅长的事。',39,'ink',600,lh=54)
text(a,795,1916,'TeamLink 把具体作品与修改上下文交接清楚。\n你仍在熟悉的环境里讨论、开发和审查。',17,'muted',400,lh=30)
roles=[('Codex','在自己的环境里理解问题、实现修改。','当前：手动导出任务包，导入返回方案。'),('飞书','承载团队明确共享的背景与正式讨论。','当前公开体验未连接真实飞书账号。'),('GitHub','承载代码、PR 与工程检查事实。','当前公开体验不向真实仓库写入。')]
for i,(name,role,boundary) in enumerate(roles):
    y=2065+i*107
    line(a,88,y-17,1264)
    text(a,88,y,name,25,'ink',600);text(a,354,y+5,role,16,'ink');text(a,910,y+7,boundary,13,'muted')
text(a,88,2401,'当前分享的是可继续编辑的副本，不是一个实时多人房间。公开样例不调用实时大模型。',13,'muted')
# Open-source closing, no fake customers or invented outcomes.
line(a,88,2460,1264)
text(a,88,2511,'先打开一件作品，\n从一个小改动开始。',39,'ink',600,lh=55)
button(a,1000,2542,352,'直接体验，无需登录  ↗',True)
text(a,1100,2625,'在 GitHub 看源码  ↗',15,'teal',550)
line(a,88,2724,1264)
logo(a,88,2750);text(a,1068,2760,'开源 · 可继续编辑 · 本地计算',13,'muted')
a.append('</svg>')
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'website-home.svg').write_text(''.join(a),encoding='utf-8')
print('Created website-home.svg, 1440×2800')
