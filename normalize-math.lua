-- texmath expects compact array columns; LaTeX itself also accepts spaces.
-- Operate on parsed math only, leaving code examples and the source untouched.
function Math(element)
  element.text = element.text:gsub(
    "(\\begin%s*{array}%s*{)([lcr|:%s]+)(})",
    function(before, columns, after)
      return before .. columns:gsub("%s+", "") .. after
    end
  )
  element.text = element.text:gsub("\\tag%s*{([%d%.%'’′]+)}", "\\qquad\\text{(%1)}")
  return element
end
