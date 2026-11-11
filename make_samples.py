# -*- coding: utf-8 -*-
"""生成各种类型的示例文件到 samples/，用于演示和测试。"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "samples")
os.makedirs(SAMPLES, exist_ok=True)


def w(name, content, enc="utf-8"):
    with open(os.path.join(SAMPLES, name), "w", encoding=enc) as f:
        f.write(content)
    print("生成", name)


# 1) 文本：会议纪要
w("会议记录_0304.txt", """会议纪要
主题：2025年一季度市场部工作安排
参会人：张伟、李娜、王强
时间：2025年3月4日
1. 讨论一季度销售数据：华东区增长 12%，华南区持平；
2. 决定下季度更新客户名单，由李娜负责；
3. 产品发布会定于 6 月，市场部提交预算。
""")

# 2) Markdown：通知
w("notice.md", """# 通知

全体员工：

关于2025年端午节放假安排的通知：6月8日至6月10日放假三天，各部门请提前做好工作安排，值班表由行政部收集。

行政部
""")

# 3) CSV：客户名单
w("clients_data_2025.csv", """客户姓名,联系电话,登记时间,跟进状态
张伟,13800001111,2025-01-12,已签约
李娜,13900002222,2025-02-03,洽谈中
王强,13700003333,2025-02-18,已签约
""", enc="gb18030")

# 4) Excel：销售明细
try:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "销售明细"
    ws.append(["月份", "产品", "销售额", "区域"])
    ws.append(["1月", "智能门锁", 320000, "华东"])
    ws.append(["2月", "智能门锁", 285000, "华东"])
    ws.append(["1月", "热成像仪", 156000, "华南"])
    ws.append(["2月", "热成像仪", 189000, "华南"])
    p = os.path.join(SAMPLES, "2025Q1 报表.xlsx")
    wb.save(p)
    print("生成", os.path.basename(p))
except Exception as e:
    print("xlsx 生成失败:", e)

# 5) PPT：发布会
try:
    from pptx import Presentation
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[1])
    s1.shapes.title.text = "2025 年度产品发布会"
    s1.placeholders[1].text = "汇报人：市场部\n时间：2025年6月"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "新品亮点"
    s2.placeholders[1].text = "• 全屋智能联动\n• 离线语音控制\n• 三年质保"
    p = os.path.join(SAMPLES, "draft_show.pptx")
    prs.save(p)
    print("生成", os.path.basename(p))
except Exception as e:
    print("pptx 生成失败:", e)

# 6) Word：合作协议
try:
    from docx import Document
    doc = Document()
    doc.add_heading("合作框架协议", level=1)
    doc.add_paragraph("甲方：XX科技有限公司　乙方：YY贸易有限公司")
    doc.add_paragraph("本协议自2025年3月起生效，有效期两年。双方就智能家居产品的区域代理、供货价格与售后服务达成如下约定：")
    t = doc.add_table(rows=2, cols=3)
    t.rows[0].cells[0].text = "区域"
    t.rows[0].cells[1].text = "代理级别"
    t.rows[0].cells[2].text = "返点"
    t.rows[1].cells[0].text = "华东"
    t.rows[1].cells[1].text = "A级"
    t.rows[1].cells[2].text = "8%"
    p = os.path.join(SAMPLES, "agreement_new.docx")
    doc.save(p)
    print("生成", os.path.basename(p))
except Exception as e:
    print("docx 生成失败:", e)

# 7) 图片：模拟年会照片
try:
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (960, 640), "#2b3a55")
    d = ImageDraw.Draw(img)
    for i in range(640):
        d.line([(0, i), (960, i)], fill=(int(43 + i * 0.25), int(58 + i * 0.2), int(85 + i * 0.3)))
    # 舞台灯柱
    d.rectangle([60, 380, 220, 640], fill="#1c2333")
    d.rectangle([740, 380, 900, 640], fill="#1c2333")
    d.rectangle([400, 300, 560, 640], fill="#0f1420")
    d.text((200, 180), "公司年会 2025", fill="#f5e9c8")
    d.ellipse([150, 120, 260, 230], fill="#d9a441")
    d.text((260, 420), "北京 · 员工合影", fill="#e8e0c8")
    p = os.path.join(SAMPLES, "IMG_20250620_193000.jpg")
    img.save(p, quality=90)
    print("生成", os.path.basename(p))
except Exception as e:
    print("图片生成失败:", e)

print("\n全部样本就绪：", SAMPLES)