MixinExampleFrameMixin = {}

function MixinExampleFrameMixin:OnLoad()
    self.TitleText:SetText("Hello from Mixin!")
    self.TitleText:SetTextColor(1, 0.82, 0)
end
