DefaultPanelTemplateMixin = {}
function DefaultPanelTemplateMixin:SetTitle(text)
  if self.TitleText then self.TitleText:SetText(text) end
end
