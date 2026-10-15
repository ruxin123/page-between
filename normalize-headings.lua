-- Pandoc readers such as FB2 can emit headings without the IDs required by EPUB navigation.
local heading_number = 0
function Header(element)
  if element.identifier == '' then
    heading_number = heading_number + 1
    element.identifier = 'reader-section-' .. heading_number
  end
  return element
end
