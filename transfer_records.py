"""Versioned portable reading records. No provider configuration or rendered HTML."""
import copy
import hashlib
import json
import math
import re

ID = re.compile(r"[0-9a-f]{32}")
IMAGE = re.compile(r"images/[0-9a-f]{64}\.(png|jpg)")


def _text(value, limit):
    return isinstance(value, str) and len(value) <= limit


def _date(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 4102444800


def _box(value):
    return isinstance(value, dict) and all(type(value.get(k)) in (int, float) and math.isfinite(value[k]) and 0 <= value[k] <= 1 for k in ('left', 'top', 'right', 'bottom')) and value['left'] < value['right'] and value['top'] < value['bottom']


def validate(data):
    from library_transfer import position
    if not isinstance(data, dict) or data.get('schema') != 1:
        raise ValueError('迁移记录格式无效。')
    images = set()
    def source(value):
        if not isinstance(value, dict) or not _text(value.get('quote'), 12000) or not _text(value.get('markdown') or '', 24000) or not _text(value.get('chapter'), 2000) or value.get('kind') not in {'text', 'equation', 'table', 'image'}:
            raise ValueError('迁移选段无效。')
        if any(not _text(value.get(key) or '', 18000) for key in ('context','contextBefore')): raise ValueError('迁移原文上下文无效。')
        value['position'] = position(value.get('position', {}))
        for key, limit in (('images', 100), ('objects', 100), ('rects', 1000)):
            if not isinstance(value.get(key), list) or len(value[key]) > limit:
                raise ValueError('迁移原图或选区无效。')
        for image in value['images']:
            if not isinstance(image, dict) or not isinstance(image.get('file'), str) or not IMAGE.fullmatch(image['file']) or not _text(image.get('raw'), 12000):
                raise ValueError('迁移原图引用无效。')
            images.add(image['file'])
        for item in value['objects'] + value['rects']:
            if not isinstance(item, dict) or type(item.get('page')) is not int or not 1 <= item['page'] <= 100000 or not _box(item.get('box')):
                raise ValueError('迁移对象位置无效。')
        for item in value['objects']:
            if item.get('type') not in {'equation', 'table', 'image'} or not _text(item.get('text'), 500000):
                raise ValueError('迁移对象内容无效。')
    for key, limit in (('excerpts', 10000), ('translations', 100), ('conversations', 10000)):
        items = data.get(key)
        if not isinstance(items, list) or len(items) > limit:
            raise ValueError('迁移记录过多。')
        seen = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not ID.fullmatch(item['id']) or item['id'] in seen or not _date(item.get('createdAt')):
                raise ValueError('迁移记录标识或时间无效。')
            seen.add(item['id']); source(item.get('source'))
            if key == 'excerpts':
                if not _text(item.get('note'), 2000) or not _text(item.get('answer') or '', 100000) or not _text(item.get('translation') or '', 100000) or (item.get('deletedAt') is not None and not _date(item['deletedAt'])):
                    raise ValueError('迁移笔记无效。')
            elif key == 'translations':
                if not all(_text(item.get(k), n) for k, n in (('text',12000), ('translation',20000), ('explanation',3000), ('model',200), ('sourceLanguage',40), ('targetLanguage',40), ('detectedLanguage',40))) or item.get('provider') not in {'google','ai'}:
                    raise ValueError('迁移翻译无效。')
            else:
                messages = item.get('messages')
                if not _date(item.get('updatedAt')) or not isinstance(messages, list) or not 1 <= len(messages) <= 1000:
                    raise ValueError('迁移对话无效。')
                ids = set()
                for message in messages:
                    if not isinstance(message, dict) or not isinstance(message.get('id'), str) or not ID.fullmatch(message['id']) or message['id'] in ids or message.get('role') not in {'user','assistant'} or not _text(message.get('content'),50000) or message.get('status') not in {None,'generating','complete','stopped','error'} or type(message.get('imageAttached',False)) is not bool:
                        raise ValueError('迁移消息无效。')
                    ids.add(message['id'])
                    if any(not _text(message.get(k) or '', n) for k,n in (('error',2000),('nearbyText',18000),('citationWarning',1000))): raise ValueError('迁移答疑状态无效。')
                    refs = message.get('references') or []
                    if not isinstance(refs,list) or len(refs)>30: raise ValueError('迁移答疑引用无效。')
                    for ref in refs:
                        if not isinstance(ref,dict) or type(ref.get('number')) is not int or not 3 <= ref['number'] <= 32 or not _text(ref.get('citation'),2000) or not _text(ref.get('text'),6000): raise ValueError('迁移答疑引用无效。')
                        ref['position'] = position(ref.get('position', {}))
    appearance = data.get('appearance')
    if appearance is not None:
        if not isinstance(appearance, dict) or not all(type(appearance.get(k)) in (int,float) and math.isfinite(appearance[k]) and lo <= appearance[k] <= hi for k,lo,hi in (('fontScale',50,200),('lineHeight',1.4,2.4),('pageMargins',.5,2))) or not _text(appearance.get('fontFamily'),200) or appearance.get('theme') not in {'paper','sage','blue','sepia','night'} or type(appearance.get('scroll')) is not bool or not _text(appearance.get('desktop') or '',4000):
            raise ValueError('迁移排版偏好无效。')
    return images


def encoded(data):
    validate(data)
    return json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def portable_position(book, value):
    from library_transfer import position
    from urllib.parse import unquote, urlsplit
    value = copy.deepcopy(value or {'index': 1})
    result = position({key: val for key, val in value.items() if val is not None})
    original = {key: val for key, val in value.items() if key in {'index','endIndex','page','top','pdfY','anchor','sourceOffset','fragment','resource','blockOrder','blockOffset','chapterFraction','progress'} and val is not None}
    raw = json.dumps(original, ensure_ascii=False, separators=(',', ':'))
    if len(raw.encode()) <= 6000: result['nativeMac'] = raw
    if value.get("transferReadium"): result["readium"] = value["transferReadium"]
    if book['type'] == 'epub':
        href = value.get('resource') or next((c['url'] for i,c in enumerate(book.get('chapters',[]),1) if i == value.get('index',1)), '')
        if '/content/' in href: result['href'] = unquote(urlsplit(href).path.split('/content/',1)[1])
    return result


def local_position(book, value):
    from library_transfer import position
    from book_import import text_chapter_index
    from urllib.parse import unquote, urlsplit
    value = position(value)
    result = {key: value[key] for key in ('index','endIndex','progress','chapterFraction','pdfY','sourceOffset') if key in value}
    if value.get('nativeMac'):
        from library_data import validate_position
        raw = json.loads(value['nativeMac']); validate_position(raw)
        raw.pop("resource", None)
        result = {**raw, **result}
    if value.get('readium'): result['transferReadium'] = value['readium']
    if book['type'] == 'txt' and 'sourceOffset' in result:
        result['index'] = text_chapter_index(book, result['sourceOffset'])
    elif book['type'] == 'epub' and value.get('href'):
        href = unquote(value['href']).split('#',1)[0]
        match = next((i for i,c in enumerate(book.get('chapters',[]),1) if unquote(urlsplit(c['url']).path).split('/content/',1)[-1] == href), None)
        if match is not None: result['index'] = match
        else:
            from book_import import BOOK_ROOT, url_for
            root = (BOOK_ROOT / book['id'] / 'content').resolve()
            target = (root / href.lstrip('/')).resolve()
            if target.is_relative_to(root) and target.is_file(): result['resource'] = url_for(target)
    count = book['pages'] if book['type'] == 'pdf' else len(book.get('chapters',[]))
    if book['type'] != 'pdf' and result['index'] > count and count: result['index'] = count
    if result['index'] > count or result.get('endIndex',result['index']) > count:
        raise ValueError('迁移原文位置超出本书范围。')
    return result


def export_book(book, state):
    import ai_tutor
    import book_images
    import book_margins
    import translation
    data = {'schema': 1, 'excerpts': [], 'translations': [], 'conversations': []}
    images = {}
    def source(raw):
        result = {'quote': raw.get('quote',''), 'position': portable_position(book, raw['position']), 'kind': raw.get('kind','text'), 'chapter': book_margins.chapter_for(book, raw['position']), 'images': [], 'objects': raw.get('transferObjects',[]), 'rects': [{'page':r['page'], 'box':dict(zip(('left','top','right','bottom'),r['bbox']))} for r in raw.get('rects',[])]}
        if raw.get('transferMarkdown') is not None: result['markdown'] = raw['transferMarkdown']
        for key in ('context','contextBefore'):
            if raw.get(key) is not None: result[key] = raw[key]
        if raw['position'].get('transferReadium'): result['position']['readium'] = raw['position']['transferReadium']
        paths = raw.get('transferImages') or ([{'url':raw['image'], 'raw':raw.get('quote','')}] if raw.get('image') else [])
        for item in paths:
            body, mime = book_images.stored_image(book, item['url'])
            path = 'images/' + hashlib.sha256(body).hexdigest() + ('.png' if mime == 'image/png' else '.jpg')
            images[path] = body
            result['images'].append({'file':path, 'raw':item.get('raw','')})
        return result
    with book_margins.LOCK:
        for item in book_margins.records(book)['items']:
            data['excerpts'].append({k:copy.deepcopy(item[k]) for k in ('id','note','answer','translation','createdAt','deletedAt') if k in item} | {'source':source(item['source'])})
    with translation.LOCK:
        for item in translation.records(book)['items']:
            data['translations'].append({k:item.get(k,'') for k in ('id','text','translation','explanation','provider','model','sourceLanguage','targetLanguage','detectedLanguage')} | {'source':source(item['source']), 'createdAt':item['createdAt']})
    with ai_tutor.LOCK:
        for item in ai_tutor.records()['conversations']:
            if item['book'] != book['id']: continue
            messages = [{k:m[k] for k in ('id','role','content','status','imageAttached','error','nearbyText','citationWarning','references') if k in m} for m in item['messages']]
            for index, m in enumerate(messages):
                m.setdefault('id', hashlib.sha256(f"{item['id']}:{index}".encode()).hexdigest()[:32])
                if m.get('status') == 'ready': m['status'] = 'complete'
                if m.get('references'): m['references'] = [{k: ref[k] for k in ('number','citation','text')} | {'position':portable_position(book,ref['position'])} for ref in m['references']]
                if m.get('status') == 'generating': m['status'] = 'stopped'
            data['conversations'].append({'id':item['id'], 'source':source(item['source']), 'messages':messages, 'createdAt':item['createdAt']/1000, 'updatedAt':item.get('updatedAt',item['createdAt'])/1000})
    prefs = state.get('bookPrefs',{}).get(book['id'])
    if prefs:
        keys = {'theme','zhFont','enFont','fontSize','lineHeight','textWidth','pdfZoom','pdfZoomMode','pdfTint','pdfInvert','paragraphSpace','headingSpace','tocOpen','pinnedTool1','pinnedTool2','textMode','pdfMode'}
        desktop = {k:v for k,v in prefs.items() if k in keys}
        data['appearance'] = {'fontScale':prefs.get('fontSize',21)/21*100, 'lineHeight':prefs.get('lineHeight',1.95), 'pageMargins':1, 'fontFamily':{'han-serif':'Songti SC','han-sans':'PingFang SC'}.get(prefs.get('zhFont'),'Georgia'), 'theme':prefs.get('theme','paper'), 'scroll':prefs.get('textMode','pages')=='scroll', 'desktop':json.dumps(desktop,ensure_ascii=False,separators=(',',':'))}
    validate(data)
    return {'recordsData':data, 'imagesData':images}


def import_book(book, data, image_paths, state):
    """Merge by stable IDs; existing records and local appearance always win."""
    import ai_tutor
    import book_images
    import book_margins
    import translation
    from book_import import BOOK_ROOT, position_label
    from paths import DATA, DATA_PREFIX
    from storage import save
    validate(data)
    directory = BOOK_ROOT / book['id']
    def source(raw):
        pos = local_position(book, raw['position'])
        result = {'quote':raw['quote'], 'context':raw.get('context',''), 'position':pos, 'citation':f"《{book['title']}》 · {position_label(book,pos)}", 'kind':raw['kind']}
        if raw.get('contextBefore') is not None: result['contextBefore'] = raw['contextBefore']
        if raw.get('markdown') is not None: result['transferMarkdown'] = raw['markdown']
        if raw['objects']: result['transferObjects'] = copy.deepcopy(raw['objects'])
        if raw['rects'] and (book['type'] != 'pdf' or any(not pos['index'] <= r['page'] <= pos.get('endIndex', pos['index']) for r in raw['rects'])): raise ValueError('迁移选区超出本书范围。')
        if raw['rects']: result['rects'] = [{'page':r['page'], 'bbox':[r['box'][k] for k in ('left','top','right','bottom')]} for r in raw['rects']]
        paths = [{'url': f"{DATA_PREFIX}/books/{book['id']}/attachments/{image_paths[item['file']].name}", 'raw': item['raw']} for item in raw['images']]
        if paths: result.update(image=paths[0]['url'], transferImages=paths)
        return result
    # Resolve all positions before modifying saved record lists.
    values = {key:[{**item,'source':source(item['source'])} for item in data[key]] for key in ('excerpts','translations','conversations')}
    appearance = data.get('appearance')
    prefs = None
    if appearance and book['id'] not in state.get('bookPrefs',{}):
        desktop = json.loads(appearance['desktop']) if appearance.get('desktop') else {}
        allowed = {'theme','zhFont','enFont','fontSize','lineHeight','textWidth','pdfZoom','pdfZoomMode','pdfTint','pdfInvert','paragraphSpace','headingSpace','tocOpen','pinnedTool1','pinnedTool2','textMode','pdfMode'}
        if not isinstance(desktop,dict) or set(desktop)-allowed or any(type(v) not in {str,bool,int,float} for v in desktop.values()): raise ValueError('桌面排版偏好无效。')
        prefs = {**desktop, 'fontSize':appearance['fontScale']*21/100, 'lineHeight':appearance['lineHeight'], 'textMode':'scroll' if appearance['scroll'] else 'pages', 'theme':'paper' if appearance['theme']=='sepia' else appearance['theme']}
        if 'zhFont' not in prefs and appearance['fontFamily']:
            prefs['zhFont'] = 'han-sans' if appearance['fontFamily']=='PingFang SC' else 'han-serif'
    counts = {'excerpts':0,'translations':0,'conversations':0}
    with book_margins.LOCK, translation.LOCK, ai_tutor.LOCK:
        margins = book_margins.records(book)
        translated = translation.records(book)
        answered = ai_tutor.records()
        def new_rows(old, incoming):
            seen = {item['id'] for item in old}
            return [item for item in incoming if item['id'] not in seen]
        excerpts = new_rows(margins['items'], values['excerpts'])
        favorites = [{**item,'favorite':True,'textVersion':translation.GOOGLE_TEXT_VERSION} for item in new_rows(translated['items'],values['translations'])]
        conversations = new_rows([item for item in answered['conversations'] if item['book'] == book['id']],values['conversations'])
        if len(margins['items']) + len(excerpts) > 10000: raise ValueError('合并后页边记录超过上限。')
        if len(translated['items']) + len(favorites) > 100: raise ValueError('合并后翻译收藏超过 100 条，请先整理。')
        for item in conversations:
            item.update(book=book['id'],createdAt=item['createdAt']*1000,updatedAt=item['updatedAt']*1000)
            for message in item['messages']:
                if message.get('status') == 'generating': message['status'] = 'stopped'
                if message.get('status') == 'complete': message['status'] = 'ready'
                if message.get('references'): message['references'] = [{**ref,'position':local_position(book,ref['position'])} for ref in message['references']]
        writes = [(directory/'margins.json', 'items', margins, excerpts), (directory/'translations.json', 'items', translated, favorites), (DATA/'ai-conversations.json', 'conversations', answered, conversations)]
        written, copied = [], []
        try:
            required = {entry['url'] for item in excerpts + favorites + conversations for entry in item['source'].get('transferImages', [])}
            for url in required:
                name = url.rsplit('/', 1)[-1]
                path = image_paths['images/' + name]
                folder = directory / 'attachments'; folder.mkdir(parents=True, exist_ok=True)
                target = folder / name
                if not target.exists():
                    import shutil
                    copied.append(target); shutil.copyfile(path, target)
                book_images.stored_image(book,url)
            for path, key, previous, additions in writes:
                if additions:
                    existed = path.exists()
                    save(path,{key:previous[key]+additions}); written.append((path,previous,existed))
        except (OSError, ValueError):
            for target in copied: target.unlink(missing_ok=True)
            for path,previous,existed in reversed(written):
                if existed: save(path,previous)
                else: path.unlink(missing_ok=True)
            raise
        counts.update(excerpts=len(excerpts),translations=len(favorites),conversations=len(conversations))
    if prefs is not None: state.setdefault('bookPrefs',{})[book['id']] = prefs
    return counts
