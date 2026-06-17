-- DepLib must already be loaded as a RequiredDep by this point.
local msg = DepLib and DepLib.GetMessage() or "ERROR: DepLib not loaded!"

if DepConsumerFrameMessage then
  DepConsumerFrameMessage:SetText(msg)
end
