-- Normalize imported metadata, heading IDs and document-contained media for EPUB.
local heading_number = 0
function Meta(metadata)
  local fallback = metadata['reader-fallback-title']
  if not metadata.title or pandoc.utils.stringify(metadata.title) == '' then
    metadata.title = pandoc.MetaString(fallback and pandoc.utils.stringify(fallback) or '电子书')
  end
  metadata['reader-fallback-title'] = nil
  return metadata
end
function Header(element)
  if element.identifier == '' then
    heading_number = heading_number + 1
    element.identifier = 'reader-section-' .. heading_number
  end
  return element
end

-- Register literal data images in the media bag without granting access to other resources.
local image_types = {
  ['image/png'] = {'.png', 'image/png'},
  ['image/jpeg'] = {'.jpg', 'image/jpeg'},
  ['image/jpg'] = {'.jpg', 'image/jpeg'},
  ['image/gif'] = {'.gif', 'image/gif'},
  ['image/svg+xml'] = {'.svg', 'image/svg+xml'},
  ['image/webp'] = {'.webp', 'image/webp'}
}
function Image(element)
  if not element.src:lower():match('^data:') then return element end
  local kind = element.src:lower():match('^data:([^;,]+)')
  local image_type = image_types[kind]
  if not image_type or #element.src > 30 * 1024 * 1024 then
    error('reader-embedded-image: unsupported or oversized image')
  end
  local header, data = element.src:match('^(.-),(.*)$')
  if not header then error('reader-embedded-image: invalid data URI') end
  data = data:gsub('%%(%x%x)', function(hex) return string.char(tonumber(hex, 16)) end)
  if header:lower():match(';base64$') then
    local encoded = data:gsub('%s', '')
    local bare = encoded:gsub('=+$', '')
    if bare:match('[^A-Za-z0-9+/]') or #encoded - #bare > 2 or #bare % 4 == 1 then
      error('reader-embedded-image: invalid base64')
    end
    encoded = bare .. string.rep('=', (4 - #bare % 4) % 4)
    local ok, mime, decoded = pcall(pandoc.mediabag.fetch, 'data:' .. image_type[2] .. ';base64,' .. encoded)
    if not ok then error('reader-embedded-image: image could not be decoded') end
    data = decoded
  end
  if type(data) ~= 'string' or #data == 0 or #data > 20 * 1024 * 1024 then
    error('reader-embedded-image: image could not be decoded')
  end
  local name = 'reader-image-' .. pandoc.utils.sha1(data) .. image_type[1]
  pandoc.mediabag.insert(name, image_type[2], data)
  element.src = name
  return element
end

function RawInline(element)
  if element.format == 'html' and element.text:lower():match('^%s*<img[%s/>]') then
    local document = pandoc.read(element.text, 'html+raw_html'):walk({Image = Image, Header = Header})
    local block = document.blocks[1]
    if #document.blocks == 1 and (block.t == 'Plain' or block.t == 'Para') then
      return block.content
    end
  end
  return element
end

function RawBlock(element)
  if element.format == 'html' and element.text:lower():match('<img[%s/>]') then
    return pandoc.read(element.text, 'html+raw_html'):walk({Image = Image, Header = Header}).blocks
  end
  return element
end
