Pod::Spec.new do |s|
  s.name           = 'StillPrivacy'
  s.version        = '1.0.0'
  s.summary        = 'Process-scoped identity for Still privacy arbitration'
  s.description    = 'Exposes native process identity for local privacy arbitration.'
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'Still'
  s.homepage       = 'https://docs.expo.dev/modules/overview/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift}'
end
