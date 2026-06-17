DepLib = {}

function DepLib.GetMessage()
  return "Hello from DepLib!"
end

function DepLib.GetVersion()
  return "1.0"
end

if DepLibFrameStatus then
  DepLibFrameStatus:SetText("v" .. DepLib.GetVersion() .. " loaded")
end
