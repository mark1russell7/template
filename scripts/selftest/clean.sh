#!/bin/sh
# Remove the build output of a package. The first argument is the package folder.
pkg=$1
rm -rf $pkg/ dist
echo "cleaned $pkg"
