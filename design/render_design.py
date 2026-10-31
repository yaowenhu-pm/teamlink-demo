from pathlib import Path
from html import escape

OUT = Path(__file__).parent
P = dict(bg='#F7F6F2', ink='#172D3B', muted='#687780', teal='#176D67', soft='#EAF3EF', line='#E0E5E1', white='#FFFFFF', wash='#F2F4F1')

def svg(width, height):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><style>text{{font-family:"PingFang SC","Noto Sans SC",sans-serif}}</style>', f'<rect width="{width}" height="{height}" fill="{P["bg"]}"/>']

def box(a,x,y,w,h,fill='white',r=16,stroke='line'):
    a.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{P.get(fill,fill)}" stroke="{P.get(stroke,stroke)}"/>')

def txt(a,x,y,s,size=15,color='ink',weight=400,line=26):
    for i,t in enumerate(s.split('\n')):
        a.append(f'<text x="{x}" y="{y+i*line+size*.86}" font-size="{size}" font-weight="{weight}" fill="{P.get(color,color)}">{escape(t)}</text>')

def rule(a,x1,y,x2):
    a.append(f'<path d="M{x1} {y}H{x2}" stroke="{P["line"]}"/>')

def pill(a,x,y,w,s,active=False,size=12):
    box(a,x,y,w,28,'soft' if active else 'wash',r=14,stroke='soft' if active else 'wash')
    txt(a,x+12,y+7,s,size,'teal' if active else 'muted',500,line=18)

def button(a,x,y,w,s):
    box(a,x,y,w,48,'teal',r=10,stroke='teal')
    txt(a,x+w/2-len(s)*7.4,y+15,s,15,'white',600,line=20)

def logo(a,x,y,small=False):
    size=26 if small else 30
    a.append(f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="8" fill="{P["teal"]}"/>')
    a.append(f'<path d="M{x+7} {y+size/2-3}h9m-4 6h9" stroke="white" stroke-width="3" stroke-linecap="round"/>')
    txt(a,x+size+10,y+2,'TeamLink',20 if small else 23,'ink',650)

def steps(a,x,y,w,mobile=False):
    names=['需求确认','研发接单','交付','验收']
    if not mobile: box(a,x,y,w,80,'white',16)
    step=w/4
    for i,name in enumerate(names):
        cx=x+step*i+(step/2 if mobile else 38)
        cy=y+(16 if mobile else 40)
        if i<3:
            a.append(f'<path d="M{cx+16} {cy}H{cx+step-16}" stroke="{P["line"]}"/>')
        a.append(f'<circle cx="{cx}" cy="{cy}" r="{11 if mobile else 15}" fill="{P["teal"] if i==0 else P["wash"]}"/>')
        txt(a,cx-3.5,cy-(7 if mobile else 8),str(i+1),11 if mobile else 13,'white' if i==0 else 'muted',600,line=16)
        txt(a,cx-(24 if mobile else -25),cy+(23 if mobile else -8),name,12 if mobile else 15,'teal' if i==0 else 'muted',600 if i==0 else 400,line=20)

def desktop():
    a=svg(1440,1080)
    a.append(f'<rect width="1440" height="76" fill="{P["bg"]}"/>')
    logo(a,80,23)
    pill(a,1112,24,86,'演示模式',True)
    txt(a,1226,31,'查看 GitHub ↗',14,'muted',500)
    rule(a,80,76,1360)
    txt(a,80,116,'把一段需求，变成双方认可的一次交接',13,'teal',550)
    txt(a,80,152,'少重复解释，把需求一路交到验收',39,'ink',650,line=50)
    txt(a,80,211,'亲手走一遍：确认需求、研发接单、提交证据，再按同一标准验收。',16,'muted')
    steps(a,80,263,1280)
    txt(a,80,376,'01  先把这次要做的事说清楚',16,'ink',600)
    txt(a,1068,379,'你现在是',13,'muted')
    box(a,1146,363,214,38,'white',r=10)
    box(a,1150,367,100,30,'soft',r=7,stroke='soft')
    txt(a,1172,375,'产品经理',13,'teal',600)
    txt(a,1275,375,'研发同学',13,'muted')
    box(a,80,424,592,556)
    txt(a,108,452,'把背景说一遍就够了',20,'ink',600)
    txt(a,108,486,'只把你确认的内容交给下一位。',14,'muted')
    rule(a,108,522,644)
    pill(a,108,542,122,'你 · 产品经理',True)
    txt(a,548,550,'可编辑预设',12,'muted')
    box(a,108,586,536,132,'wash',r=12,stroke='line')
    txt(a,128,605,'想给活动报名加一个候补名单。\n名额满了先排队，有人取消后按顺序递补，\n也让用户知道自己排到了第几位。',16,'ink',400,line=29)
    txt(a,108,739,'换个场景',12,'muted')
    pill(a,177,730,86,'活动报名',True)
    pill(a,272,730,86,'用户反馈')
    pill(a,367,730,86,'成员邀请')
    txt(a,108,792,'TeamLink',13,'teal',600)
    txt(a,108,818,'已整理出范围与验收标准。\n确认后，研发接到的是这一版，而不是另一段转述。',14,'muted',400,line=25)
    button(a,108,895,536,'确认并交接  →')
    txt(a,225,955,'演示数据 · 不会向真实团队发送消息',12,'muted')
    box(a,696,424,664,556)
    txt(a,724,452,'双方看到同一份任务',20,'ink',600)
    pill(a,1245,448,87,'待你确认',True)
    txt(a,724,502,'活动报名：候补名单',23,'ink',600)
    txt(a,724,540,'需求版本',12,'muted')
    txt(a,724,562,'草稿 · 尚未确认',14,'ink',500)
    txt(a,1028,540,'负责人',12,'muted')
    txt(a,1028,562,'小林 · 研发（虚构）',14,'ink',500)
    rule(a,724,600,1332)
    txt(a,724,620,'本次范围',13,'muted',550)
    txt(a,724,650,'名额满时进入候补；取消后顺序递补；显示排队位置。',15,'ink')
    txt(a,724,695,'验收标准',13,'muted',550)
    txt(a,724,726,'□  满员后报名进入候补，不占用正式名额。\n□  有人取消后，首位候补自动递补并收到提示。',14,'ink',400,line=29)
    rule(a,724,798,1332)
    txt(a,734,819,'飞书预览',14,'teal',600)
    txt(a,840,819,'GitHub 预览',14,'muted')
    a.append(f'<path d="M724 848H812" stroke="{P["teal"]}" stroke-width="2"/>')
    txt(a,1020,822,'模拟视图 · 不会写入真实账号',12,'muted')
    box(a,724,865,608,87,'soft',r=10,stroke='soft')
    txt(a,744,881,'TeamLink 共享记录',13,'teal',600)
    txt(a,744,908,'确认后同步需求版本、负责人和验收标准。',13,'ink')
    txt(a,80,1014,'所有人物、任务与工程记录均为虚构。你可以安全试错，再重新开始。',12,'muted')
    txt(a,1285,1014,'重置演示',12,'teal',550)
    a.append('</svg>')
    return ''.join(a)

def mobile():
    a=svg(390,1630)
    logo(a,24,22,True)
    pill(a,280,22,86,'演示模式',True)
    rule(a,24,72,366)
    txt(a,24,100,'团队交接 · 互动演示',12,'teal',550)
    txt(a,24,130,'少重复解释，\n把需求一路交到验收',28,'ink',650,line=41)
    txt(a,24,224,'用一份共同确认的任务，完成一次交接。',13,'muted')
    steps(a,24,270,342,True)
    box(a,24,352,342,42,'white',r=10)
    box(a,28,356,167,34,'soft',r=7,stroke='soft')
    txt(a,76,365,'产品经理',14,'teal',600)
    txt(a,241,365,'研发同学',14,'muted')
    box(a,24,414,342,506)
    txt(a,44,438,'把背景说一遍就够了',19,'ink',600)
    txt(a,44,472,'只共享你确认的内容。',13,'muted')
    rule(a,44,505,346)
    pill(a,44,524,122,'你 · 产品经理',True)
    txt(a,278,532,'可编辑',11,'muted')
    box(a,44,568,302,135,'wash',r=11,stroke='line')
    txt(a,60,584,'想给活动报名加一个候补名单。\n名额满了先排队，有人取消后\n按顺序递补，也让用户知道\n自己排到了第几位。',14,'ink',400,line=26)
    pill(a,44,721,86,'活动报名',True)
    pill(a,140,721,86,'用户反馈')
    pill(a,236,721,86,'成员邀请')
    txt(a,44,777,'TeamLink 已整理好范围与验收标准。\n下一位接到的，就是你确认的这一版。',13,'muted',400,line=24)
    button(a,44,843,302,'确认并交接  →')
    box(a,24,940,342,594)
    txt(a,44,964,'同一份共享任务',19,'ink',600)
    pill(a,257,960,87,'待你确认',True)
    txt(a,44,1010,'活动报名：候补名单',20,'ink',600)
    txt(a,44,1047,'草稿 · 尚未确认',13,'muted')
    txt(a,44,1081,'负责人   小林 · 研发（虚构）',13,'ink')
    rule(a,44,1116,346)
    txt(a,44,1135,'本次范围',12,'muted',550)
    txt(a,44,1163,'满员候补、顺序递补、显示排队位置。',14,'ink')
    txt(a,44,1208,'验收标准',12,'muted',550)
    txt(a,44,1236,'□  满员报名进入候补，不占正式名额。\n□  取消后首位候补递补，并收到提示。',13,'ink',400,line=28)
    rule(a,44,1311,346)
    txt(a,52,1332,'飞书预览',14,'teal',600)
    txt(a,162,1332,'GitHub 预览',14,'muted')
    a.append(f'<path d="M44 1362H130" stroke="{P["teal"]}" stroke-width="2"/>')
    txt(a,44,1379,'模拟视图 · 不会写入真实账号',11,'muted')
    box(a,44,1410,302,99,'soft',r=10,stroke='soft')
    txt(a,60,1427,'TeamLink 共享记录',13,'teal',600)
    txt(a,60,1455,'确认后同步需求版本、负责人\n和验收标准。',13,'ink',400,line=23)
    txt(a,24,1558,'人物与记录均为虚构，不会发送真实消息。',11,'muted')
    txt(a,24,1586,'重置演示',12,'teal',550)
    a.append('</svg>')
    return ''.join(a)

OUT.mkdir(parents=True, exist_ok=True)
(OUT/'desktop-core.svg').write_text(desktop(), encoding='utf-8')
(OUT/'mobile-core.svg').write_text(mobile(), encoding='utf-8')
print('Created editable desktop-core.svg (1440×1080) and mobile-core.svg (390×1630)')
