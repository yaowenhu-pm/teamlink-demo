from pathlib import Path
from html import escape

OUT=Path(__file__).parent
C={'bg':'#F7F6F2','ink':'#172D3B','muted':'#687780','teal':'#176D67','soft':'#EAF3EF','line':'#E0E5E1','white':'#FFFFFF','wash':'#F2F4F1','amber':'#91662A','amberbg':'#FBF4E8'}
def box(a,x,y,w,h,color='white',r=12,stroke='line',dash=False):
    a.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{C.get(color,color)}" stroke="{C.get(stroke,stroke)}"'+(' stroke-dasharray="4 4"' if dash else '')+'/>')
def text(a,x,y,s,size=14,color='ink',weight=400,lh=23):
    for i,line in enumerate(s.split('\n')):
        a.append(f'<text x="{x}" y="{y+i*lh+size*.86}" font-size="{size}" font-weight="{weight}" fill="{C.get(color,color)}">{escape(line)}</text>')
def line(a,x,y,w,color='line',dash=False):
    a.append(f'<path d="M{x} {y}h{w}" stroke="{C.get(color,color)}"'+(' stroke-dasharray="4 4"' if dash else '')+'/>')
def begin(w,h):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><style>text{{font-family:"PingFang SC","Noto Sans SC",sans-serif}}</style>',f'<rect width="{w}" height="{h}" fill="{C["bg"]}"/>']
def logo(a,x,y):
    box(a,x,y,26,26,'teal',7,'teal')
    a.append(f'<path d="M{x+6} {y+10}h9m-4 6h9" stroke="white" stroke-width="2.5" stroke-linecap="round"/>')
    text(a,x+36,y+1,'TeamLink',20,'ink',650)
def button(a,x,y,w,label,primary=False):
    box(a,x,y,w,38,'teal' if primary else 'white',8,'teal' if primary else 'line')
    text(a,x+16,y+12,label,13,'white' if primary else 'ink',550)
def select(a,x,y,w,label,value):
    text(a,x,y,label,12,'muted')
    box(a,x,y+23,w,42,'white',8)
    text(a,x+12,y+36,value,14,'ink',500)
    text(a,x+w-26,y+36,'⌄',14,'muted')
def toggle(a,x,y,on=True):
    box(a,x,y,40,22,'teal' if on else 'line',11,'teal' if on else 'line')
    a.append(f'<circle cx="{x+(29 if on else 11)}" cy="{y+11}" r="8" fill="white"/>')

def desktop():
    a=begin(1440,1000)
    logo(a,44,20)
    text(a,205,27,'共创画布',14,'muted',500)
    text(a,975,29,'↶  撤销',13,'muted')
    text(a,1055,29,'↷  重做',13,'#AAB3B5')
    button(a,1140,15,124,'保留对照  ✓')
    button(a,1280,15,116,'分享  ↗')
    line(a,44,70,1352)
    text(a,44,100,'直接改作品，整个过程马上改变。',25,'ink',650)
    text(a,44,140,'改文案、筛选条件或行为规则；下面会同时展示请求、错误、重试与文件的变化。',14,'muted')
    # The product is the primary object, never a process gate.
    box(a,44,184,850,353,'white',16)
    text(a,76,206,'你正在共同打磨的作品',12,'muted')
    text(a,733,207,'文字可直接编辑',12,'muted')
    text(a,76,239,'导出项目记录',28,'ink',650)
    line(a,76,274,169,'teal')
    text(a,76,288,'按月份与分类筛选，导出你眼前的数据。',15,'ink')
    select(a,76,331,252,'月份','2026 年 10 月')
    select(a,344,331,228,'分类','产品')
    button(a,666,354,196,'导出 2 条记录  →',True)
    box(a,76,422,786,82,'amberbg',10,'amberbg')
    text(a,94,439,'这次导出超时，筛选条件已保留。',15,'ink',500)
    text(a,94,468,'再试一次就好，无需重新填写。',13,'muted')
    button(a,732,441,112,'再试一次',True)
    # Natural, executable policy next to the actual artifact.
    box(a,918,184,478,353,'white',16)
    text(a,942,207,'这件作品怎样工作',18,'ink',600)
    text(a,942,242,'失败后，保留用户已经选好的条件',14,'ink')
    toggle(a,1328,240,True)
    line(a,942,282,430)
    text(a,942,303,'重试时使用',13,'muted')
    box(a,1050,294,182,36,'soft',8,'soft')
    text(a,1064,305,'眼前的筛选条件',14,'teal',550)
    text(a,1251,305,'首次条件',14,'muted')
    line(a,942,352,430)
    text(a,942,374,'等待',14,'ink')
    text(a,994,366,'2.0',25,'teal',650)
    line(a,992,399,54,'teal')
    text(a,1060,374,'秒后超时',14,'ink')
    text(a,1198,375,'↔  左右拖动数值',12,'muted')
    text(a,942,431,'所有结果都从当前规则与下方数据演算。',13,'muted')
    text(a,942,465,'演算假设：首次请求超时，重试成功。\n示例没有连接真实导出服务。',12,'muted',400,lh=21)
    # One full causal trace: current versus a preserved baseline.
    text(a,44,570,'从你选择的数据，到最后拿到的文件',19,'ink',600)
    text(a,1138,574,'━━  当前作品',12,'teal',550)
    text(a,1260,574,'┄┄  保留的对照',12,'muted')
    traces=[
      ('01  首次请求','10 月 / 产品','请求 2 条记录','10 月 / 产品 · 同样 2 条'),
      ('02  发生超时','2.0 秒后超时','筛选仍是：10 月 / 产品','5.0 秒超时 · 筛选被清空'),
      ('03  再次请求','使用眼前条件','10 月 / 产品 → 2 条','全部 / 全部 → 4 条'),
      ('04  收到文件','10月-产品.csv','2 条 · 与筛选一致','4 条 · 多出 2 条无关记录'),
    ]
    for i,(title,value,detail,baseline) in enumerate(traces):
        x=44+i*342
        box(a,x,609,326,157,'white',12)
        text(a,x+18,626,title,12,'muted',550)
        text(a,x+18,654,value,19,'ink',600)
        text(a,x+18,685,detail,13,'teal',500)
        line(a,x+18,717,290,'line',True)
        text(a,x+18,735,baseline,12,'muted')
    # Editable source data, close to the consequences it controls.
    text(a,44,796,'作品使用的数据',18,'ink',600)
    text(a,218,800,'直接改单元格，筛选结果与导出文件一起更新。',13,'muted')
    text(a,1226,800,'当前命中 2 / 4 条',12,'teal',550)
    box(a,44,833,1352,137,'white',10)
    box(a,45,834,1350,29,'wash',9,'wash')
    for x,label in [(64,'日期'),(258,'分类'),(456,'记录内容'),(1240,'当前筛选')]: text(a,x,842,label,12,'muted',550)
    rows=[('2026-10-03','产品','用户需求回访','包含'),('2026-10-18','产品','报名体验修正','包含'),('2026-10-24','研发','导出接口联调','未包含'),('2026-09-25','产品','历史项目记录','未包含')]
    for i,row in enumerate(rows):
        y=870+i*24
        if i: line(a,64,y-5,1310)
        for x,value in zip([64,258,456,1240],row): text(a,x,y,value,12,'teal' if value=='包含' else 'ink')
    text(a,44,985,'虚构数据 · 改动仅留在本次浏览器。对照是一份快照，不会跟着当前修改。',10,'muted')
    a.append('</svg>')
    return ''.join(a)

OUT.mkdir(parents=True,exist_ok=True)
(OUT/'canvas-v2.svg').write_text(desktop(),encoding='utf-8')
print('Created editable canvas-v2.svg, 1440×1000')
